"""
Pre-Open Snapshot Fetcher
=========================
Fetches GIFT Nifty + global indices from MoneyControl pre-market API
at ~9:10 AM IST (before Indian market opens at 9:15 AM) and writes
opening-gap prediction features to preopen_snapshot and macro_asset_prices.

Also fetches per-stock NSE pre-open IEP (Indicated Equilibrium Price) data
for F&O stocks and Nifty 50, writing to preopen_stock_snapshot and
backfilling iep_gap_pct + preopen_imbalance into technical_signals.

Run:  python preopen_fetcher.py
"""

import datetime

import requests
from curl_cffi import requests as cffi_req

from db_compat import connect, translate, use_postgres
import sys

MC_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Accept": "application/json",
}

# Keep backward-compat alias used by fetch_section()
HEADERS = MC_HEADERS

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/html",
    "Referer": "https://www.nseindia.com/",
}

NSE_PREOPEN_FO    = "https://www.nseindia.com/api/market-data-pre-open?key=FO"
NSE_PREOPEN_NIFTY = "https://www.nseindia.com/api/market-data-pre-open?key=NIFTY"

MI_URL = "https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=mi"
II_URL = "https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=ii"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

def ensure_preopen_stock_schema(con) -> None:
    cur = con.cursor()
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS preopen_stock_snapshot (
            symbol            TEXT NOT NULL,
            snapshot_date     TEXT NOT NULL,
            iep               REAL,
            prev_close        REAL,
            iep_gap_pct       REAL,
            total_buy_qty     REAL,
            total_sell_qty    REAL,
            preopen_imbalance REAL,
            last_price        REAL,
            fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, snapshot_date)
        )
    """))
    con.commit()

    # Add IEP columns to technical_signals (skip if already present)
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN iep_gap_pct       REAL",
        "ALTER TABLE technical_signals ADD COLUMN preopen_imbalance REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS preopen_snapshot (
            snapshot_date  TEXT NOT NULL,
            snapshot_time  TEXT,
            gift_nifty     REAL,
            gift_nifty_chg REAL,
            gift_nifty_pct REAL,
            dj_futures     REAL,
            dj_futures_pct REAL,
            hang_seng_pct  REAL,
            nikkei_pct     REAL,
            nasdaq_pct     REAL,
            asia_sentiment REAL,
            global_risk_score REAL,
            fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (snapshot_date)
        )
    """))
    con.commit()


# ---------------------------------------------------------------------------
# Fetch helpers
# ---------------------------------------------------------------------------

def _parse_float(val: str | None) -> float | None:
    """Parse a comma-formatted number string like '23,969.50' or '-0.60'."""
    if val is None:
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def fetch_section(url: str) -> list[dict]:
    r = cffi_req.get(url, headers=HEADERS, impersonate="chrome110", timeout=10)
    r.raise_for_status()
    data = r.json()
    # API returns either a list or {"data": [...]}
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "result", "items"):
            if isinstance(data.get(key), list):
                return data[key]
    return []


def _find(items: list[dict], *name_fragments: str) -> dict | None:
    """Case-insensitive partial name match."""
    for item in items:
        name = (item.get("name") or "").lower()
        if all(frag.lower() in name for frag in name_fragments):
            return item
    return None


# ---------------------------------------------------------------------------
# NSE pre-open IEP fetch
# ---------------------------------------------------------------------------

def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(NSE_HEADERS)
    try:
        s.get("https://www.nseindia.com/", timeout=10)
    except Exception:
        pass
    return s


def _fetch_nse_preopen_url(sess: requests.Session, url: str) -> list[dict]:
    try:
        r = sess.get(url, timeout=12)
        if r.status_code == 403:
            print(f"[NSE PreOpen] 403 from {url} — NSE blocked the request (expected outside market hours or if cookies expired)")
            return []
        r.raise_for_status()
        data = r.json()
        return data.get("data") or []
    except Exception as e:
        print(f"[NSE PreOpen] Warning: fetch failed for {url}: {e}", file=sys.stderr)
        return []


def fetch_nse_preopen(con) -> int:
    """Fetch NSE pre-open IEP data for F&O + Nifty 50 stocks.

    Writes to preopen_stock_snapshot and backfills the most recent
    technical_signals row per symbol with iep_gap_pct + preopen_imbalance.

    Returns count of stocks upserted.
    """
    ensure_preopen_stock_schema(con)

    sess = _nse_session()
    raw_fo    = _fetch_nse_preopen_url(sess, NSE_PREOPEN_FO)
    raw_nifty = _fetch_nse_preopen_url(sess, NSE_PREOPEN_NIFTY)

    # Merge, dedup by symbol (FO takes priority if duplicate)
    merged: dict[str, dict] = {}
    for item in (raw_nifty + raw_fo):
        meta = item.get("metadata") or {}
        sym = (meta.get("symbol") or "").strip().upper()
        if sym:
            merged[sym] = item

    if not merged:
        print("[NSE PreOpen] No data returned — skipping IEP backfill")
        return 0

    snapshot_date = datetime.datetime.now().strftime("%Y-%m-%d")
    fetched_at    = datetime.datetime.now().isoformat()

    rows = []
    for sym, item in merged.items():
        meta = item.get("metadata") or {}
        detail = item.get("detail") or {}
        preopen_mkt = detail.get("preOpenMarket") or {}

        iep        = _parse_float(meta.get("iep"))
        prev_close = _parse_float(meta.get("previousClose") or meta.get("prevClose"))
        last_price = _parse_float(meta.get("lastPrice") or meta.get("ltp"))
        buy_qty    = _parse_float(preopen_mkt.get("totalBuyQuantity") or meta.get("totalBuyQuantity") or meta.get("buyQuantity"))
        sell_qty   = _parse_float(preopen_mkt.get("totalSellQuantity") or meta.get("totalSellQuantity") or meta.get("sellQuantity"))

        iep_gap_pct = None
        if iep is not None and prev_close and prev_close != 0:
            iep_gap_pct = (iep - prev_close) / prev_close * 100

        preopen_imbalance = None
        if buy_qty is not None and sell_qty is not None:
            total = (buy_qty or 0) + (sell_qty or 0)
            if total > 0:
                preopen_imbalance = ((buy_qty or 0) - (sell_qty or 0)) / total

        rows.append((
            sym, snapshot_date,
            iep, prev_close, iep_gap_pct,
            buy_qty, sell_qty, preopen_imbalance,
            last_price, fetched_at,
        ))

    cur = con.cursor()

    # Upsert into preopen_stock_snapshot
    for row in rows:
        cur.execute(translate("""
            INSERT INTO preopen_stock_snapshot
                (symbol, snapshot_date, iep, prev_close, iep_gap_pct,
                 total_buy_qty, total_sell_qty, preopen_imbalance, last_price, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol, snapshot_date) DO UPDATE SET
                iep               = excluded.iep,
                prev_close        = excluded.prev_close,
                iep_gap_pct       = excluded.iep_gap_pct,
                total_buy_qty     = excluded.total_buy_qty,
                total_sell_qty    = excluded.total_sell_qty,
                preopen_imbalance = excluded.preopen_imbalance,
                last_price        = excluded.last_price,
                fetched_at        = excluded.fetched_at
        """), row)
    con.commit()

    # Backfill today's technical_signals row per symbol.
    # date = ? guard (2026-07-19): previously matched created_at = MAX(created_at), but
    # technical_signals.created_at is NULL for 100% of rows in production (nothing else in
    # this codebase sets it) -- MAX(created_at) is therefore always NULL, and `created_at =
    # NULL` never matches in SQL, so this UPDATE has never actually written a row, ever.
    # Uses snapshot_date (this batch's own date), not a fresh now() call, to stay consistent
    # with what was just written to preopen_stock_snapshot above.
    for (sym, sd, _iep, _pc, iep_gap_pct, _bq, _sq, preopen_imbalance, _lp, _fa) in rows:
        if iep_gap_pct is None and preopen_imbalance is None:
            continue
        cur.execute(
            """
            UPDATE technical_signals
            SET iep_gap_pct = ?, preopen_imbalance = ?
            WHERE symbol = ? AND date = ?
            """,
            (iep_gap_pct, preopen_imbalance, sym, sd),
        )
    con.commit()

    # Summary
    gap_ups   = sum(1 for r in rows if r[4] is not None and r[4] > 1.0)
    gap_downs = sum(1 for r in rows if r[4] is not None and r[4] < -1.0)
    buy_heavy = sum(1 for r in rows if r[7] is not None and r[7] > 0.3)
    sell_heavy= sum(1 for r in rows if r[7] is not None and r[7] < -0.3)
    print(
        f"[NSE PreOpen] {len(rows)} stocks | "
        f"Gap-up >1%: {gap_ups} | Gap-down <-1%: {gap_downs} | "
        f"Buy-heavy (>0.3): {buy_heavy} | Sell-heavy (<-0.3): {sell_heavy}"
    )
    return len(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run() -> None:
    now = datetime.datetime.now()
    snapshot_date = now.strftime("%Y-%m-%d")
    snapshot_time = now.strftime("%H:%M:%S")

    # ── Fetch MI section (GIFT Nifty, Dow Futures, Nasdaq Futures, …) ──────
    mi_items = fetch_section(MI_URL)

    gift_row = _find(mi_items, "gift", "nifty")
    djf_row  = _find(mi_items, "dow", "jones", "futures") or _find(mi_items, "dow jones")
    nas_row  = _find(mi_items, "nasdaq")

    gift_nifty     = _parse_float(gift_row.get("ltp")    if gift_row else None)
    gift_nifty_chg = _parse_float(gift_row.get("chg")    if gift_row else None)
    gift_nifty_pct = _parse_float(gift_row.get("chgper") if gift_row else None)
    dj_futures     = _parse_float(djf_row.get("ltp")     if djf_row  else None)
    dj_futures_pct = _parse_float(djf_row.get("chgper")  if djf_row  else None)
    nasdaq_pct     = _parse_float(nas_row.get("chgper")  if nas_row  else None)

    # ── Fetch II section (Hang Seng, Nikkei, …) ────────────────────────────
    ii_items = fetch_section(II_URL)

    hs_row  = _find(ii_items, "hang seng") or _find(ii_items, "hang", "seng")
    nik_row = _find(ii_items, "nikkei")

    hang_seng_pct = _parse_float(hs_row.get("chgper")  if hs_row  else None)
    nikkei_pct    = _parse_float(nik_row.get("chgper") if nik_row else None)

    # ── Derived features ────────────────────────────────────────────────────
    asia_vals = [v for v in (hang_seng_pct, nikkei_pct) if v is not None]
    asia_sentiment = sum(asia_vals) / len(asia_vals) if asia_vals else None

    if gift_nifty_pct is not None and dj_futures_pct is not None and asia_sentiment is not None:
        global_risk_score = (
            0.5 * gift_nifty_pct
            + 0.2 * dj_futures_pct
            + 0.3 * asia_sentiment
        )
    elif gift_nifty_pct is not None:
        # Fallback: use only GIFT Nifty when others are unavailable
        global_risk_score = gift_nifty_pct
    else:
        global_risk_score = None

    # ── Persist ─────────────────────────────────────────────────────────────
    con = connect()
    ensure_schema(con)
    cur = con.cursor()

    cur.execute(translate("""
        INSERT INTO preopen_snapshot
            (snapshot_date, snapshot_time, gift_nifty, gift_nifty_chg,
             gift_nifty_pct, dj_futures, dj_futures_pct,
             hang_seng_pct, nikkei_pct, nasdaq_pct,
             asia_sentiment, global_risk_score, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(snapshot_date) DO UPDATE SET
            snapshot_time    = excluded.snapshot_time,
            gift_nifty       = excluded.gift_nifty,
            gift_nifty_chg   = excluded.gift_nifty_chg,
            gift_nifty_pct   = excluded.gift_nifty_pct,
            dj_futures       = excluded.dj_futures,
            dj_futures_pct   = excluded.dj_futures_pct,
            hang_seng_pct    = excluded.hang_seng_pct,
            nikkei_pct       = excluded.nikkei_pct,
            nasdaq_pct       = excluded.nasdaq_pct,
            asia_sentiment   = excluded.asia_sentiment,
            global_risk_score= excluded.global_risk_score,
            fetched_at       = excluded.fetched_at
    """), (
        snapshot_date, snapshot_time,
        gift_nifty, gift_nifty_chg, gift_nifty_pct,
        dj_futures, dj_futures_pct,
        hang_seng_pct, nikkei_pct, nasdaq_pct,
        asia_sentiment, global_risk_score,
        now.isoformat(),
    ))
    con.commit()

    # ── Write to macro_asset_prices for ml_ensemble join ────────────────────
    macro_rows = [
        ("GIFT_NIFTY_CHG_PCT", snapshot_date, gift_nifty_pct),
        ("ASIA_SENTIMENT",     snapshot_date, asia_sentiment),
        ("GLOBAL_RISK_SCORE",  snapshot_date, global_risk_score),
    ]
    for asset_name, date, close in macro_rows:
        if close is None:
            continue
        cur.execute(translate("""
            INSERT INTO macro_asset_prices (symbol, date, close)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close
        """), (asset_name, date, close))
    con.commit()

    # ── NSE per-stock IEP pre-open data ─────────────────────────────────────
    fetch_nse_preopen(con)

    con.close()

    # ── Console summary ─────────────────────────────────────────────────────
    gift_str = (
        f"{gift_nifty:,.1f} ({gift_nifty_pct:+.2f}%)"
        if gift_nifty is not None and gift_nifty_pct is not None
        else "N/A"
    )
    asia_str  = f"{asia_sentiment:+.2f}%"  if asia_sentiment    is not None else "N/A"
    risk_str  = f"{global_risk_score:+.2f}" if global_risk_score is not None else "N/A"
    print(f"[PreOpen] GIFT Nifty: {gift_str} | Asia: {asia_str} | Risk score: {risk_str}")


if __name__ == "__main__":
    run()
