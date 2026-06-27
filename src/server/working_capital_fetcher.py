#!/usr/bin/env python3
"""
Working Capital Fetcher â€” Cash Conversion Cycle
================================================
Computes the working capital cycle (cash conversion cycle) from Trendlyne's
chart-data API. A deteriorating cycle is an early warning signal that shows up
2-3 quarters before earnings impact; an improving cycle signals operational excellence.

Metrics:
  Receivables days = (Trade Receivables / Revenue) Ã— 365
  Inventory days   = (Inventory / COGS) Ã— 365
  Payables days    = (Trade Payables / COGS) Ã— 365
  CCC              = Receivables days + Inventory days - Payables days
  CCC trend        = ccc_ttm - ccc 4 quarters ago (positive = deteriorating)

Writes:
  working_capital_history  (symbol, quarter) â€” per-quarter computed values
  technical_signals        â€” receivables_days_ttm, ccc_ttm, ccc_trend,
                             wc_deteriorating, wc_improving

Run:
  python working_capital_fetcher.py              # all stocks with tlid
  python working_capital_fetcher.py --symbol BEL
  python working_capital_fetcher.py --limit 50
"""

import argparse
import time
from datetime import date, datetime, timezone

import requests

from db_compat import connect

# â”€â”€ API config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

BASE_URL = "https://trendlyne.com/mapp/v1/stock/chart-data/{tlid}/{param}/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}

RATE_LIMIT_SEC = 0.4  # 5 calls per stock â†’ 2s total per stock

# Trendlyne chart-data quarterly param names.
# Primary names tried first; fallbacks used if primary returns no data.
PARAM_RECEIVABLES  = "TRADE_RECEIVABLE_Q"   # fallback: DEBTORS_Q
PARAM_INVENTORY    = "INVENTORIES_Q"
PARAM_PAYABLES     = "TRADE_PAYABLE_Q"      # fallback: CREDITORS_Q
PARAM_REVENUE      = "REVENUE_Q"
PARAM_COGS         = "COGS_Q"               # fallback: RAW_MATERIAL_Q

# â”€â”€ Schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS working_capital_history (
            symbol           TEXT NOT NULL,
            quarter          TEXT NOT NULL,
            receivables_days REAL,
            inventory_days   REAL,
            payables_days    REAL,
            ccc              REAL,
            revenue_qtr      REAL,
            cogs_qtr         REAL,
            fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, quarter)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_wch_sym
        ON working_capital_history(symbol, quarter DESC)
    """)
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN receivables_days_ttm REAL",
        "ALTER TABLE technical_signals ADD COLUMN ccc_ttm              REAL",
        "ALTER TABLE technical_signals ADD COLUMN ccc_trend            REAL",
        "ALTER TABLE technical_signals ADD COLUMN wc_deteriorating     INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN wc_improving         INTEGER DEFAULT 0",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# â”€â”€ Fetch helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fetch(tlid: str, param: str, session: requests.Session) -> dict | None:
    url = BASE_URL.format(tlid=tlid, param=param)
    try:
        r = session.get(url, params={"format": "json"}, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        if data.get("head", {}).get("status") != "0":
            return None
        return data.get("body", {})
    except Exception as e:
        print(f"  [{param}] error: {e}")
        return None


def _fetch_with_fallback(tlid: str, primary: str, fallback: str,
                          session: requests.Session) -> list[tuple[str, float]]:
    """Fetch a quarterly series, trying fallback param if primary yields no data."""
    body = _fetch(tlid, primary, session)
    time.sleep(RATE_LIMIT_SEC)
    series = _parse_eod(body) if body else []
    if not series:
        body = _fetch(tlid, fallback, session)
        time.sleep(RATE_LIMIT_SEC)
        series = _parse_eod(body) if body else []
    return series


def _ts_to_quarter(ts_ms: int) -> str:
    """Convert millisecond timestamp to quarter label like 'Q4FY26'."""
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    year = dt.year
    month = dt.month
    # Indian FY: Apr-Mar. FY26 = Apr 2025 - Mar 2026.
    if month >= 4:
        fy = year + 1
    else:
        fy = year
    q_map = {4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 3,
              1: 4, 2: 4, 3: 4}
    q = q_map[month]
    return f"Q{q}FY{str(fy)[2:]}"


def _parse_eod(body: dict) -> list[tuple[str, float]]:
    """Return [(quarter_label, value), ...] sorted most-recent first."""
    series: list[tuple[str, float]] = []
    for ts_ms, val in body.get("eodData", []):
        try:
            series.append((_ts_to_quarter(int(ts_ms)), float(val)))
        except (TypeError, ValueError):
            continue
    # TL returns newest first; maintain that order
    return series


def _avg_n(series: list[tuple[str, float]], n: int = 4) -> float | None:
    """Average of the n most-recent values (trailing n-quarter average)."""
    vals = [v for _, v in series[:n] if v is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


def _align_quarters(
    *series_list: list[tuple[str, float]],
) -> list[tuple[str, list[float | None]]]:
    """
    Align multiple quarterly series by quarter label.
    Returns [(quarter, [v1, v2, ...]), ...] for quarters present in all series,
    sorted most-recent first.
    """
    if not series_list:
        return []
    # Build quarter â†’ value maps
    maps = [{q: v for q, v in s} for s in series_list]
    # Quarters present in at least the first (primary) series
    quarters = [q for q, _ in series_list[0]]
    aligned = []
    for q in quarters:
        values = [m.get(q) for m in maps]
        aligned.append((q, values))
    return aligned


# â”€â”€ CCC computation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _compute_ccc_series(
    receivables: list[tuple[str, float]],
    inventory:   list[tuple[str, float]],
    payables:    list[tuple[str, float]],
    revenue:     list[tuple[str, float]],
    cogs:        list[tuple[str, float]],
) -> list[tuple[str, float, float, float, float, float, float]]:
    """
    For each quarter where all inputs are available, compute:
      receivables_days, inventory_days, payables_days, ccc, revenue_qtr, cogs_qtr
    Returns list of (quarter, rec_days, inv_days, pay_days, ccc, rev_qtr, cogs_qtr),
    most-recent first.
    """
    rec_map  = {q: v for q, v in receivables}
    inv_map  = {q: v for q, v in inventory}
    pay_map  = {q: v for q, v in payables}
    rev_map  = {q: v for q, v in revenue}
    cog_map  = {q: v for q, v in cogs}

    # Use quarters from the receivables series as the primary timeline
    results = []
    for q, _ in receivables:
        rec  = rec_map.get(q)
        inv  = inv_map.get(q)
        pay  = pay_map.get(q)
        rev  = rev_map.get(q)
        cog  = cog_map.get(q)

        if rec is None or rev is None or rev == 0:
            continue

        rec_days = rec / rev * 365

        inv_days: float | None = None
        if inv is not None and cog is not None and cog != 0:
            inv_days = inv / cog * 365

        pay_days: float | None = None
        if pay is not None and cog is not None and cog != 0:
            pay_days = pay / cog * 365

        if inv_days is None or pay_days is None:
            # CCC requires all three legs; still store partial
            ccc = None
        else:
            ccc = rec_days + inv_days - pay_days

        results.append((
            q,
            round(rec_days, 2),
            round(inv_days, 2) if inv_days is not None else None,
            round(pay_days, 2) if pay_days is not None else None,
            round(ccc, 2) if ccc is not None else None,
            round(rev, 2) if rev is not None else None,
            round(cog, 2) if cog is not None else None,
        ))

    return results


# â”€â”€ Persist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _upsert_wc_history(symbol: str, rows: list, con) -> None:
    cur = con.cursor()
    for (q, rec_days, inv_days, pay_days, ccc, rev_qtr, cogs_qtr) in rows:
        cur.execute("""
            INSERT INTO working_capital_history
                (symbol, quarter, receivables_days, inventory_days,
                 payables_days, ccc, revenue_qtr, cogs_qtr)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol, quarter) DO UPDATE SET
                receivables_days = excluded.receivables_days,
                inventory_days   = excluded.inventory_days,
                payables_days    = excluded.payables_days,
                ccc              = excluded.ccc,
                revenue_qtr      = excluded.revenue_qtr,
                cogs_qtr         = excluded.cogs_qtr,
                fetched_at       = CURRENT_TIMESTAMP
        """, (symbol, q, rec_days, inv_days, pay_days, ccc, rev_qtr, cogs_qtr))
    con.commit()


def _update_technical_signals(symbol: str, features: dict, con) -> None:
    if not features:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            receivables_days_ttm = COALESCE(?, receivables_days_ttm),
            ccc_ttm              = COALESCE(?, ccc_ttm),
            ccc_trend            = COALESCE(?, ccc_trend),
            wc_deteriorating     = COALESCE(?, wc_deteriorating),
            wc_improving         = COALESCE(?, wc_improving)
        WHERE symbol = ?
    """, (
        features.get("receivables_days_ttm"),
        features.get("ccc_ttm"),
        features.get("ccc_trend"),
        features.get("wc_deteriorating"),
        features.get("wc_improving"),
        symbol,
    ))
    con.commit()


# â”€â”€ Stock list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_stocks(symbol_filter: str | None, limit: int | None, con) -> list[tuple[str, str]]:
    cur = con.cursor()
    cur.execute("""
        SELECT symbol, tlid::TEXT AS tlid FROM nse_stocks
        WHERE symbol IS NOT NULL AND tlid IS NOT NULL AND tlid::TEXT != ''
        UNION
        SELECT tss.symbol, MAX(tss.stock_id)::TEXT AS tlid
        FROM trendlyne_screener_stocks tss
        WHERE tss.stock_id IS NOT NULL AND tss.stock_id::TEXT != ''
          AND NOT EXISTS (SELECT 1 FROM nse_stocks ns WHERE ns.symbol = tss.symbol AND ns.tlid IS NOT NULL)
        GROUP BY tss.symbol
        ORDER BY symbol
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0] is not None]

    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# â”€â”€ Per-stock processing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def process_stock(symbol: str, tlid: str,
                  session: requests.Session, con) -> dict:
    """Fetch working capital components, compute CCC, persist, return features."""

    # â”€â”€ 1. Trade receivables (primary: TRADE_RECEIVABLE_Q, fallback: DEBTORS_Q) â”€â”€
    receivables = _fetch_with_fallback(tlid, PARAM_RECEIVABLES, "DEBTORS_Q", session)

    # â”€â”€ 2. Inventory â”€â”€
    body_inv = _fetch(tlid, PARAM_INVENTORY, session)
    time.sleep(RATE_LIMIT_SEC)
    inventory = _parse_eod(body_inv) if body_inv else []

    # â”€â”€ 3. Trade payables (primary: TRADE_PAYABLE_Q, fallback: CREDITORS_Q) â”€â”€
    payables = _fetch_with_fallback(tlid, PARAM_PAYABLES, "CREDITORS_Q", session)

    # â”€â”€ 4. Revenue â”€â”€
    body_rev = _fetch(tlid, PARAM_REVENUE, session)
    time.sleep(RATE_LIMIT_SEC)
    revenue = _parse_eod(body_rev) if body_rev else []

    # â”€â”€ 5. COGS (primary: COGS_Q, fallback: RAW_MATERIAL_Q) â”€â”€
    cogs = _fetch_with_fallback(tlid, PARAM_COGS, "RAW_MATERIAL_Q", session)

    if not receivables or not revenue:
        return {}

    # â”€â”€ Compute per-quarter CCC â”€â”€
    ccc_series = _compute_ccc_series(receivables, inventory, payables, revenue, cogs)

    if not ccc_series:
        return {}

    _upsert_wc_history(symbol, ccc_series, con)

    # â”€â”€ Derive TTM features from 4 most-recent quarters â”€â”€
    # ccc_series rows: (quarter, rec_days, inv_days, pay_days, ccc, rev_qtr, cogs_qtr)
    rec_series_clean  = [(r[0], r[1]) for r in ccc_series if r[1] is not None]
    ccc_series_clean  = [(r[0], r[4]) for r in ccc_series if r[4] is not None]

    receivables_days_ttm = _avg_n(rec_series_clean, 4)
    ccc_ttm              = _avg_n(ccc_series_clean, 4)

    # CCC trend: recent 4Q avg vs prior 4Q avg (quarters 5-8)
    ccc_trend: float | None = None
    prior_ccc = _avg_n(ccc_series_clean[4:8], 4) if len(ccc_series_clean) >= 8 else None
    if ccc_ttm is not None and prior_ccc is not None:
        ccc_trend = round(ccc_ttm - prior_ccc, 2)

    wc_deteriorating = 1 if (ccc_trend is not None and ccc_trend > 5)  else 0
    wc_improving     = 1 if (ccc_trend is not None and ccc_trend < -5) else 0

    features = {
        "receivables_days_ttm": round(receivables_days_ttm, 2) if receivables_days_ttm is not None else None,
        "ccc_ttm":              round(ccc_ttm, 2)              if ccc_ttm              is not None else None,
        "ccc_trend":            ccc_trend,
        "wc_deteriorating":     wc_deteriorating,
        "wc_improving":         wc_improving,
    }
    _update_technical_signals(symbol, features, con)
    return features


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cash Conversion Cycle (working capital) from Trendlyne"
    )
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit",  type=int, default=None, help="Process first N stocks")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, args.limit, con)
    if not stocks:
        print("[WorkingCapital] No stocks with tlid found.")
        con.close()
        return

    print(f"[WorkingCapital] Processing {len(stocks)} stocks â€” cash conversion cycleâ€¦")
    session = requests.Session()
    session.headers.update(HEADERS)

    ok               = 0
    ccc_sum          = 0.0
    ccc_count        = 0
    deteriorating    = 0
    improving        = 0

    for i, (symbol, tlid) in enumerate(stocks, 1):
        try:
            features = process_stock(symbol, tlid, session, con)
            if not features:
                print(f"  [{i}/{len(stocks)}] {symbol}: no data")
                continue

            ok += 1
            ccc = features.get("ccc_ttm")
            trend = features.get("ccc_trend")

            if ccc is not None:
                ccc_sum   += ccc
                ccc_count += 1

            if features.get("wc_deteriorating"):
                deteriorating += 1
            if features.get("wc_improving"):
                improving += 1

            ccc_str   = f"CCC={ccc:.1f}d"   if ccc   is not None else "CCC=n/a"
            trend_str = f"trend={trend:+.1f}d" if trend is not None else "trend=n/a"
            flag = ""
            if features.get("wc_deteriorating"):
                flag = " [DETERIORATING]"
            elif features.get("wc_improving"):
                flag = " [IMPROVING]"
            print(f"  [{i}/{len(stocks)}] {symbol}: {ccc_str} | {trend_str}{flag}")

        except Exception as e:
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR â€” {e}")

    ccc_avg = round(ccc_sum / ccc_count, 1) if ccc_count else 0
    print(
        f"[WorkingCapital] Done. {ok} stocks. "
        f"CCC avg: {ccc_avg} days. "
        f"Deteriorating (>5d trend): {deteriorating} stocks. "
        f"Improving: {improving} stocks."
    )
    con.close()


if __name__ == "__main__":
    main()
