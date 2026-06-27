#!/usr/bin/env python3
"""
Trendlyne Advanced Technical Analysis Fetcher (Daily)
======================================================
Fetches Trendlyne's advanced technical analysis per stock (daily frequency).
One API call per stock returns MA signals, oscillators, pivot points, price
returns, delivery/volume averages, and beta.

Endpoint:
  https://trendlyne.com/equity/api/stock/adv-technical-analysis/{tlid}/24/?format=json
  where 24 = daily frequency (available_frequency["1D"] = 24)
  ?format=json is required â€” DRF returns HTML without it.

Writes to:
  trendlyne_adv_tech_daily  (symbol, date, PRIMARY KEY) â€” full daily snapshot
  technical_signals         â€” back-filled with derived ML features

ML features written to technical_signals:
  ma_bull_frac       = ma_bull / (ma_bull + ma_bear)   â€” fraction of MAs bullish
  osc_bull_frac      = osc_bull / (osc_bull + osc_bear) â€” fraction of oscillators bullish
  adx_tl             = ADX value (trend strength)
  atr_pct_tl         = ATR / current_price * 100        â€” normalised volatility
  mfi_tl             = Money Flow Index
  pivot_dist_pct_tl  = (price - pivot) / pivot * 100    â€” distance from pivot
  delivery_avg_1m_tl = 1-month delivery %
  beta_1y_tl         = 1-year beta
  ret_1m_tl          = 1-month return %
  ret_3m_tl          = 3-month return %
  ret_6m_tl          = 6-month return %
  ret_1y_tl          = 1-year return %

Run:
  python trendlyne_adv_tech_fetcher.py              # all stocks
  python trendlyne_adv_tech_fetcher.py --symbol BEL # single stock
"""

import argparse
import time
from datetime import date

import requests

from db_compat import connect

BASE_URL = (
    "https://trendlyne.com/equity/api/stock/adv-technical-analysis/{tlid}/24/"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}

RATE_LIMIT_SEC = 0.5

# Total count of MA signals (8 SMA + 8 EMA = 16) and oscillator signals (9)
# used as denominators for the fractional features.
MA_TOTAL = 16
OSC_TOTAL = 9


# â”€â”€ Schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_adv_tech_daily (
            symbol              TEXT    NOT NULL,
            date                TEXT    NOT NULL,
            -- MA signals
            ma_bull             INTEGER,
            ma_bear             INTEGER,
            osc_bull            INTEGER,
            osc_bear            INTEGER,
            -- Individual oscillator values
            rsi                 REAL,
            macd                REAL,
            macd_hist           REAL,
            adx                 REAL,
            atr                 REAL,
            mfi                 REAL,
            cci                 REAL,
            roc_21              REAL,
            roc_125             REAL,
            william             REAL,
            uo                  REAL,
            momentum_score      REAL,
            current_price       REAL,
            -- Pivot points
            pivot               REAL,
            r1                  REAL,
            s1                  REAL,
            pivot_dist_pct      REAL,
            -- Price returns
            ret_1d              REAL,
            ret_1w              REAL,
            ret_1m              REAL,
            ret_3m              REAL,
            ret_6m              REAL,
            ret_1y              REAL,
            ret_3y              REAL,
            ret_5y              REAL,
            -- Volume / delivery
            delivery_pct_day    REAL,
            delivery_pct_week   REAL,
            delivery_pct_1m     REAL,
            delivery_pct_6m     REAL,
            vol_avg_day         REAL,
            vol_avg_week        REAL,
            vol_avg_1m          REAL,
            -- Beta
            beta_1m             REAL,
            beta_3m             REAL,
            beta_1y             REAL,
            beta_3y             REAL,
            fetched_at          TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    for idx in [
        "CREATE INDEX IF NOT EXISTS idx_tlat_sym  ON trendlyne_adv_tech_daily(symbol, date DESC)",
        "CREATE INDEX IF NOT EXISTS idx_tlat_date ON trendlyne_adv_tech_daily(date)",
    ]:
        cur.execute(idx)
    con.commit()  # commit DDL before ALTER so Postgres doesn't abort the tx

    # Back-fill columns on technical_signals â€” each ALTER in its own commit/rollback
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN ma_bull_frac      REAL",
        "ALTER TABLE technical_signals ADD COLUMN osc_bull_frac     REAL",
        "ALTER TABLE technical_signals ADD COLUMN adx_tl            REAL",
        "ALTER TABLE technical_signals ADD COLUMN atr_pct_tl        REAL",
        "ALTER TABLE technical_signals ADD COLUMN mfi_tl            REAL",
        "ALTER TABLE technical_signals ADD COLUMN pivot_dist_pct_tl REAL",
        "ALTER TABLE technical_signals ADD COLUMN delivery_avg_1m_tl REAL",
        "ALTER TABLE technical_signals ADD COLUMN beta_1y_tl        REAL",
        "ALTER TABLE technical_signals ADD COLUMN ret_1m_tl         REAL",
        "ALTER TABLE technical_signals ADD COLUMN ret_3m_tl         REAL",
        "ALTER TABLE technical_signals ADD COLUMN ret_6m_tl         REAL",
        "ALTER TABLE technical_signals ADD COLUMN ret_1y_tl         REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# â”€â”€ Fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def fetch_adv_tech(tlid: str, session: requests.Session) -> dict | None:
    """Fetch the raw advanced-technical JSON body for a given tlid.
    Returns the parsed ``body.parameters`` dict or None on failure."""
    url = BASE_URL.format(tlid=tlid)
    try:
        r = session.get(url, params={"format": "json"}, timeout=15)
        if r.status_code != 200:
            print(f"  HTTP {r.status_code} for tlid={tlid}")
            return None
        data = r.json()
        body = data.get("body", {})
        params = body.get("parameters")
        if params is None:
            # Some responses wrap differently â€” try top-level body as params
            params = body if body else None
        return params
    except Exception as e:
        print(f"  fetch error (tlid={tlid}): {e}")
        return None


# â”€â”€ Extract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fval(d: dict, key: str) -> float | None:
    """Safely extract a float from a nested {"value": ...} dict."""
    try:
        v = d.get(key, {})
        if isinstance(v, dict):
            val = v.get("value")
        else:
            val = v
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _safe_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def extract_features(params: dict) -> dict:
    """Parse the raw parameters dict into a flat feature dict.

    All numeric values are native Python float/int so Postgres accepts them
    (np.float64 would be rejected).
    """
    feat: dict = {}

    # â”€â”€ MA signals â”€â”€
    ma = params.get("ma_signal", {})
    feat["ma_bull"] = int(ma.get("bullish", 0))
    feat["ma_bear"] = int(ma.get("bearish", 0))

    # â”€â”€ Oscillator signals â”€â”€
    osc = params.get("oscillator_signal", {})
    feat["osc_bull"] = int(osc.get("bullish", 0))
    feat["osc_bear"] = int(osc.get("bearish", 0))

    # â”€â”€ Individual indicators â”€â”€
    feat["rsi"]            = _fval(params, "rsi")
    feat["macd"]           = _fval(params, "macd")
    feat["macd_hist"]      = _fval(params, "macdhistogram")
    feat["adx"]            = _fval(params, "adx")
    feat["atr"]            = _fval(params, "atr")
    feat["mfi"]            = _fval(params, "mfi")
    feat["cci"]            = _fval(params, "cci")
    feat["roc_21"]         = _fval(params, "roc_21")
    feat["roc_125"]        = _fval(params, "roc_125")
    feat["william"]        = _fval(params, "william")
    feat["uo"]             = _fval(params, "uo")
    feat["momentum_score"] = _fval(params, "momentum")
    feat["current_price"]  = _safe_float(params.get("current_price"))

    # â”€â”€ Pivot points â”€â”€
    pivot_lvl = params.get("pivot_level", {})
    feat["pivot"] = _fval(pivot_lvl, "pivot_point")
    feat["r1"]    = _fval(pivot_lvl, "R1")
    feat["s1"]    = _fval(pivot_lvl, "S1")

    # Pivot distance %: (price - pivot) / pivot * 100
    if feat["current_price"] and feat["pivot"] and feat["pivot"] != 0:
        feat["pivot_dist_pct"] = round(
            (feat["current_price"] - feat["pivot"]) / feat["pivot"] * 100, 4
        )
    else:
        feat["pivot_dist_pct"] = None

    # â”€â”€ Price returns â”€â”€
    # Map period name â†’ column key
    ret_map = {
        "1 Day":    "ret_1d",
        "1 Week":   "ret_1w",
        "1 Month":  "ret_1m",
        "3 Months": "ret_3m",
        "6 Months": "ret_6m",
        "1 Year":   "ret_1y",
        "3 Year":   "ret_3y",
        "5 Year":   "ret_5y",
    }
    for entry in params.get("price_analysis", []):
        col = ret_map.get(entry.get("name"))
        if col:
            feat[col] = _safe_float(entry.get("changePercent"))

    # â”€â”€ Volume / delivery analysis â”€â”€
    # tableData rows: [period_label, avg_vol, delivery_pct, del_vol]
    vol_map = {
        "Day":     ("vol_avg_day",   "delivery_pct_day"),
        "Week":    ("vol_avg_week",  "delivery_pct_week"),
        "1 Month": ("vol_avg_1m",    "delivery_pct_1m"),
        "6 Month": ("delivery_pct_6m", None),          # only delivery_pct for 6m
    }
    va = params.get("volume_analysis", {})
    for row in va.get("tableData", []):
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        label = str(row[0])
        mapping = vol_map.get(label)
        if mapping is None:
            continue
        vol_col, del_col = mapping if len(mapping) == 2 else (mapping[0], None)
        if vol_col and vol_col.startswith("delivery"):
            # 6 Month row: only store delivery_pct (index 2)
            feat["delivery_pct_6m"] = _safe_float(row[2])
        else:
            if vol_col:
                feat[vol_col] = _safe_float(row[1])
            if del_col:
                feat[del_col] = _safe_float(row[2])

    # â”€â”€ Beta â”€â”€
    beta_map = {
        "1 Month": "beta_1m",
        "3 Month": "beta_3m",
        "1 Year":  "beta_1y",
        "3 Year":  "beta_3y",
    }
    for entry in params.get("beta_analysis", []):
        col = beta_map.get(entry.get("label"))
        if col:
            feat[col] = _safe_float(entry.get("data"))

    # â”€â”€ Derived ML fractions â”€â”€
    ma_total = feat["ma_bull"] + feat["ma_bear"]
    feat["ma_bull_frac"] = (
        round(feat["ma_bull"] / ma_total, 4) if ma_total > 0 else 0.5
    )

    osc_total = feat["osc_bull"] + feat["osc_bear"]
    feat["osc_bull_frac"] = (
        round(feat["osc_bull"] / osc_total, 4) if osc_total > 0 else 0.5
    )

    if feat.get("atr") is not None and feat.get("current_price"):
        feat["atr_pct"] = round(feat["atr"] / feat["current_price"] * 100, 4)
    else:
        feat["atr_pct"] = None

    return feat


# â”€â”€ Persist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def upsert_row(symbol: str, today: str, feat: dict, con) -> None:
    """Insert or replace the daily row for (symbol, today)."""
    cur = con.cursor()
    cur.execute("""
        INSERT INTO trendlyne_adv_tech_daily (
            symbol, date,
            ma_bull, ma_bear, osc_bull, osc_bear,
            rsi, macd, macd_hist, adx, atr, mfi, cci,
            roc_21, roc_125, william, uo, momentum_score, current_price,
            pivot, r1, s1, pivot_dist_pct,
            ret_1d, ret_1w, ret_1m, ret_3m, ret_6m, ret_1y, ret_3y, ret_5y,
            delivery_pct_day, delivery_pct_week, delivery_pct_1m, delivery_pct_6m,
            vol_avg_day, vol_avg_week, vol_avg_1m,
            beta_1m, beta_3m, beta_1y, beta_3y,
            fetched_at
        ) VALUES (
            ?,?,
            ?,?,?,?,
            ?,?,?,?,?,?,?,
            ?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,?,?,?,?,?,
            ?,?,?,?,
            ?,?,?,
            ?,?,?,?,
            CURRENT_TIMESTAMP
        )
        ON CONFLICT(symbol, date) DO UPDATE SET
            ma_bull            = excluded.ma_bull,
            ma_bear            = excluded.ma_bear,
            osc_bull           = excluded.osc_bull,
            osc_bear           = excluded.osc_bear,
            rsi                = excluded.rsi,
            macd               = excluded.macd,
            macd_hist          = excluded.macd_hist,
            adx                = excluded.adx,
            atr                = excluded.atr,
            mfi                = excluded.mfi,
            cci                = excluded.cci,
            roc_21             = excluded.roc_21,
            roc_125            = excluded.roc_125,
            william            = excluded.william,
            uo                 = excluded.uo,
            momentum_score     = excluded.momentum_score,
            current_price      = excluded.current_price,
            pivot              = excluded.pivot,
            r1                 = excluded.r1,
            s1                 = excluded.s1,
            pivot_dist_pct     = excluded.pivot_dist_pct,
            ret_1d             = excluded.ret_1d,
            ret_1w             = excluded.ret_1w,
            ret_1m             = excluded.ret_1m,
            ret_3m             = excluded.ret_3m,
            ret_6m             = excluded.ret_6m,
            ret_1y             = excluded.ret_1y,
            ret_3y             = excluded.ret_3y,
            ret_5y             = excluded.ret_5y,
            delivery_pct_day   = excluded.delivery_pct_day,
            delivery_pct_week  = excluded.delivery_pct_week,
            delivery_pct_1m    = excluded.delivery_pct_1m,
            delivery_pct_6m    = excluded.delivery_pct_6m,
            vol_avg_day        = excluded.vol_avg_day,
            vol_avg_week       = excluded.vol_avg_week,
            vol_avg_1m         = excluded.vol_avg_1m,
            beta_1m            = excluded.beta_1m,
            beta_3m            = excluded.beta_3m,
            beta_1y            = excluded.beta_1y,
            beta_3y            = excluded.beta_3y,
            fetched_at         = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        feat.get("ma_bull"),   feat.get("ma_bear"),
        feat.get("osc_bull"),  feat.get("osc_bear"),
        feat.get("rsi"),       feat.get("macd"),      feat.get("macd_hist"),
        feat.get("adx"),       feat.get("atr"),       feat.get("mfi"),
        feat.get("cci"),       feat.get("roc_21"),    feat.get("roc_125"),
        feat.get("william"),   feat.get("uo"),
        feat.get("momentum_score"),   feat.get("current_price"),
        feat.get("pivot"),     feat.get("r1"),        feat.get("s1"),
        feat.get("pivot_dist_pct"),
        feat.get("ret_1d"),    feat.get("ret_1w"),    feat.get("ret_1m"),
        feat.get("ret_3m"),    feat.get("ret_6m"),    feat.get("ret_1y"),
        feat.get("ret_3y"),    feat.get("ret_5y"),
        feat.get("delivery_pct_day"),  feat.get("delivery_pct_week"),
        feat.get("delivery_pct_1m"),   feat.get("delivery_pct_6m"),
        feat.get("vol_avg_day"),       feat.get("vol_avg_week"),
        feat.get("vol_avg_1m"),
        feat.get("beta_1m"),   feat.get("beta_3m"),
        feat.get("beta_1y"),   feat.get("beta_3y"),
    ))
    con.commit()


# â”€â”€ Back-fill technical_signals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def backfill_technical_signals(symbol: str, feat: dict, con) -> None:
    """Write ML features derived from the fetched data into technical_signals.

    Uses COALESCE so existing (non-NULL) values are not overwritten by a NULL.
    Updates all rows for the symbol (no date filter) â€” technical_signals rows
    are rolling and contain only the latest state per symbol.
    """
    if not feat:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            ma_bull_frac       = COALESCE(?, ma_bull_frac),
            osc_bull_frac      = COALESCE(?, osc_bull_frac),
            adx_tl             = COALESCE(?, adx_tl),
            atr_pct_tl         = COALESCE(?, atr_pct_tl),
            mfi_tl             = COALESCE(?, mfi_tl),
            pivot_dist_pct_tl  = COALESCE(?, pivot_dist_pct_tl),
            delivery_avg_1m_tl = COALESCE(?, delivery_avg_1m_tl),
            beta_1y_tl         = COALESCE(?, beta_1y_tl),
            ret_1m_tl          = COALESCE(?, ret_1m_tl),
            ret_3m_tl          = COALESCE(?, ret_3m_tl),
            ret_6m_tl          = COALESCE(?, ret_6m_tl),
            ret_1y_tl          = COALESCE(?, ret_1y_tl)
        WHERE symbol = ?
    """, (
        feat.get("ma_bull_frac"),
        feat.get("osc_bull_frac"),
        feat.get("adx"),
        feat.get("atr_pct"),
        feat.get("mfi"),
        feat.get("pivot_dist_pct"),
        feat.get("delivery_pct_1m"),
        feat.get("beta_1y"),
        feat.get("ret_1m"),
        feat.get("ret_3m"),
        feat.get("ret_6m"),
        feat.get("ret_1y"),
        symbol,
    ))
    con.commit()


# â”€â”€ Stock list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _load_stocks(symbol_filter: str | None, con) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...].
    Primary: nse_stocks.tlid (canonical). Fallback: trendlyne_screener_stocks.stock_id.
    """
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
    return rows


# â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch Trendlyne advanced technical analysis (daily) per stock."
    )
    parser.add_argument(
        "--symbol", default=None,
        help="Process a single NSE symbol (e.g. BEL). Omit to process all stocks."
    )
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[TLAdvTech] No stocks with tlid found.")
        con.close()
        return

    print(f"[TLAdvTech] Processing {len(stocks)} stocks â€” daily adv-technicalâ€¦")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()

    ok = 0
    skipped = 0

    for i, (symbol, tlid) in enumerate(stocks, 1):
        params = fetch_adv_tech(tlid, session)
        if params is None:
            print(f"  [{i}/{len(stocks)}] {symbol}: SKIP (no data)")
            skipped += 1
            time.sleep(RATE_LIMIT_SEC)
            continue

        feat = extract_features(params)
        upsert_row(symbol, today, feat, con)
        backfill_technical_signals(symbol, feat, con)

        # Summary line
        ma_str  = f"MA {feat.get('ma_bull', '?')}up/{feat.get('ma_bear', '?')}dn"
        osc_str = f"OSC {feat.get('osc_bull', '?')}up/{feat.get('osc_bear', '?')}dn"
        rsi_str = f"RSI={feat.get('rsi', '?')}"
        adx_str = f"ADX={feat.get('adx', '?')}"
        ret_str = f"1m={feat.get('ret_1m', '?')}% 3m={feat.get('ret_3m', '?')}%"
        pdist   = f"pvt_dist={feat.get('pivot_dist_pct', '?'):.2f}%" if feat.get("pivot_dist_pct") is not None else "pvt_dist=?"
        print(
            f"  [{i}/{len(stocks)}] {symbol}: {ma_str} | {osc_str} | "
            f"{rsi_str} | {adx_str} | {ret_str} | {pdist}"
        )
        ok += 1
        time.sleep(RATE_LIMIT_SEC)

    print(f"[TLAdvTech] Done. {ok} OK / {skipped} skipped out of {len(stocks)} stocks.")
    con.close()


if __name__ == "__main__":
    main()
