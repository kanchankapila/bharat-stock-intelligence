#!/usr/bin/env python3
"""
Trendlyne Price Performance Analysis Fetcher (Weekly)
======================================================
Fetches https://trendlyne.com/share-price/price-performance-analysis/{tlid}/?format=json

Unique ML data:
  1. Relative alpha vs Nifty50/Sensex/Industry/Sector for 1M/3M/6M/1Y/3Y/5Y
     (stock_return - benchmark_return = alpha)
  2. Monthly seasonality per stock: 5-year avg return for each calendar month
     (some stocks consistently strong in Nov/Dec, weak in Jan/Feb)
  3. Distance from period highs/lows (quarterly, annual)

ML features written to technical_signals:
  tl_vs_nifty_1m      â€” alpha vs Nifty50 over 1 month (stock% - nifty%)
  tl_vs_nifty_3m      â€” alpha vs Nifty50 over 3 months
  tl_vs_nifty_6m      â€” alpha vs Nifty50 over 6 months
  tl_vs_ind_1m        â€” alpha vs Industry over 1 month
  tl_vs_ind_3m        â€” alpha vs Industry over 3 months
  tl_seasonal_month_5y â€” 5-year avg return for current calendar month
  tl_dist_3m_high_pct  â€” % distance from 3-month high (negative = below high)
  tl_dist_3m_low_pct   â€” % distance from 3-month low (positive = above low)

Run:
  python trendlyne_price_analysis_fetcher.py             # all stocks
  python trendlyne_price_analysis_fetcher.py --symbol BEL
"""

import argparse
import time
from datetime import date

import requests

from db_compat import connect

ANALYSIS_URL = "https://trendlyne.com/share-price/price-performance-analysis/{tlid}/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}

RATE_LIMIT_SEC = 0.5

# Map period name from returnsComparison to column key
PERIOD_MAP = {
    "1 Mth":  "1m",
    "3 Mths": "3m",
    "6 Mths": "6m",
    "1 Yr":   "1y",
    "3 Yrs":  "3y",
    "5 Yrs":  "5y",
}

# returnsComparison tableHeaders order:
# [Period, Stock, Nifty50, Sensex, Industry, Sector]
IDX_STOCK    = 1
IDX_NIFTY    = 2
IDX_SENSEX   = 3
IDX_INDUSTRY = 4
IDX_SECTOR   = 5

# returnsDeepDive tableHeaders order:
# [Time, Returns (%), Summary, Open (Rs), High (Rs), Low (Rs), Close (Rs), Dist % from High, Dist % from Low]
IDX_DD_PERIOD    = 0
IDX_DD_HIGH_DIST = 7
IDX_DD_LOW_DIST  = 8

PERIOD_DD_MAP = {
    "Day":  "1d",
    "Week": "1w",
    "Month": "1m",
    "Qtr":   "3m",
    "HalfYr": "6m",
    "1Yr":    "1y",
}


# â”€â”€ Schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_price_analysis (
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            stock_ret_1m    REAL, stock_ret_3m REAL, stock_ret_6m REAL,
            stock_ret_1y    REAL, stock_ret_3y REAL, stock_ret_5y REAL,
            nifty_ret_1m    REAL, nifty_ret_3m REAL, nifty_ret_6m REAL,
            nifty_ret_1y    REAL, nifty_ret_3y REAL, nifty_ret_5y REAL,
            ind_ret_1m      REAL, ind_ret_3m   REAL, ind_ret_6m   REAL,
            alpha_nifty_1m  REAL, alpha_nifty_3m REAL, alpha_nifty_6m REAL,
            alpha_ind_1m    REAL, alpha_ind_3m   REAL,
            seasonal_jan    REAL, seasonal_feb REAL, seasonal_mar REAL,
            seasonal_apr    REAL, seasonal_may REAL, seasonal_jun REAL,
            seasonal_jul    REAL, seasonal_aug REAL, seasonal_sep REAL,
            seasonal_oct    REAL, seasonal_nov REAL, seasonal_dec REAL,
            dist_3m_high_pct REAL, dist_3m_low_pct REAL,
            fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tlpa_sym ON trendlyne_price_analysis(symbol, date DESC)")
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN tl_vs_nifty_1m       REAL",
        "ALTER TABLE technical_signals ADD COLUMN tl_vs_nifty_3m       REAL",
        "ALTER TABLE technical_signals ADD COLUMN tl_vs_nifty_6m       REAL",
        "ALTER TABLE technical_signals ADD COLUMN tl_vs_ind_1m         REAL",
        "ALTER TABLE technical_signals ADD COLUMN tl_vs_ind_3m         REAL",
        "ALTER TABLE technical_signals ADD COLUMN tl_seasonal_month_5y REAL",
        "ALTER TABLE technical_signals ADD COLUMN tl_dist_3m_high_pct  REAL",
        "ALTER TABLE technical_signals ADD COLUMN tl_dist_3m_low_pct   REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# â”€â”€ Fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _fetch(tlid: str, session: requests.Session) -> dict | None:
    url = ANALYSIS_URL.format(tlid=tlid)
    try:
        r = session.get(url, params={"format": "json"}, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        if data.get("head", {}).get("status") != "0":
            return None
        return data.get("body", {})
    except Exception as e:
        print(f"  [{tlid}] price-analysis error: {e}")
        return None


def _sf(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def extract_features(body: dict, today: date) -> dict:
    feat: dict = {}

    # â”€â”€ Returns comparison vs benchmarks â”€â”€
    returns_cmp = body.get("returnsComparison", {})
    for row in returns_cmp.get("tableData", []):
        period_label = str(row[0]) if row else ""
        key = PERIOD_MAP.get(period_label)
        if not key:
            continue
        stock_ret = _sf(row[IDX_STOCK]    if len(row) > IDX_STOCK    else None)
        nifty_ret = _sf(row[IDX_NIFTY]    if len(row) > IDX_NIFTY    else None)
        ind_ret   = _sf(row[IDX_INDUSTRY] if len(row) > IDX_INDUSTRY else None)
        feat[f"stock_ret_{key}"] = stock_ret
        feat[f"nifty_ret_{key}"] = nifty_ret
        feat[f"ind_ret_{key}"]   = ind_ret
        if stock_ret is not None and nifty_ret is not None:
            feat[f"alpha_nifty_{key}"] = round(stock_ret - nifty_ret, 2)
        if stock_ret is not None and ind_ret is not None:
            feat[f"alpha_ind_{key}"] = round(stock_ret - ind_ret, 2)

    # â”€â”€ Returns deep dive â€” distance from period high/low â”€â”€
    dd = body.get("returnsDeepDive", {})
    for row in dd.get("tableData", []):
        label = str(row[IDX_DD_PERIOD]) if len(row) > IDX_DD_PERIOD else ""
        if "Qtr" in label or "3" in label:
            if len(row) > IDX_DD_HIGH_DIST:
                feat["dist_3m_high_pct"] = _sf(row[IDX_DD_HIGH_DIST])
            if len(row) > IDX_DD_LOW_DIST:
                feat["dist_3m_low_pct"]  = _sf(row[IDX_DD_LOW_DIST])

    # â”€â”€ Monthly seasonality â€” 5-year avg returns â”€â”€
    MONTH_NAMES = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    pattern_data = body.get("returnsPatternData", {})
    monthly = pattern_data.get("Monthly", {})
    five_yr = monthly.get("5Yr Avg", [])
    for entry in five_yr:
        m = entry.get("m")  # 1â€“12
        v = _sf(entry.get("v"))
        if m is not None and v is not None:
            try:
                feat[f"seasonal_{MONTH_NAMES[int(m) - 1]}"] = v
            except (IndexError, TypeError, ValueError):
                pass

    # Current month's 5-yr avg return
    cur_month = today.month
    try:
        feat["tl_seasonal_month_5y"] = feat.get(f"seasonal_{MONTH_NAMES[cur_month - 1]}")
    except IndexError:
        pass

    return feat


def upsert_row(symbol: str, today_str: str, f: dict, con) -> None:
    SEASONAL_COLS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    cur = con.cursor()
    cur.execute(f"""
        INSERT INTO trendlyne_price_analysis (
            symbol, date,
            stock_ret_1m, stock_ret_3m, stock_ret_6m, stock_ret_1y, stock_ret_3y, stock_ret_5y,
            nifty_ret_1m, nifty_ret_3m, nifty_ret_6m, nifty_ret_1y, nifty_ret_3y, nifty_ret_5y,
            ind_ret_1m, ind_ret_3m, ind_ret_6m,
            alpha_nifty_1m, alpha_nifty_3m, alpha_nifty_6m,
            alpha_ind_1m, alpha_ind_3m,
            seasonal_jan, seasonal_feb, seasonal_mar, seasonal_apr, seasonal_may, seasonal_jun,
            seasonal_jul, seasonal_aug, seasonal_sep, seasonal_oct, seasonal_nov, seasonal_dec,
            dist_3m_high_pct, dist_3m_low_pct
        ) VALUES ({','.join(['?']*36)})
        ON CONFLICT(symbol, date) DO UPDATE SET
            stock_ret_1m=excluded.stock_ret_1m, stock_ret_3m=excluded.stock_ret_3m,
            stock_ret_6m=excluded.stock_ret_6m, stock_ret_1y=excluded.stock_ret_1y,
            nifty_ret_1m=excluded.nifty_ret_1m, nifty_ret_3m=excluded.nifty_ret_3m,
            nifty_ret_6m=excluded.nifty_ret_6m, nifty_ret_1y=excluded.nifty_ret_1y,
            ind_ret_1m=excluded.ind_ret_1m, ind_ret_3m=excluded.ind_ret_3m,
            alpha_nifty_1m=excluded.alpha_nifty_1m, alpha_nifty_3m=excluded.alpha_nifty_3m,
            alpha_nifty_6m=excluded.alpha_nifty_6m,
            alpha_ind_1m=excluded.alpha_ind_1m, alpha_ind_3m=excluded.alpha_ind_3m,
            seasonal_jan=excluded.seasonal_jan, seasonal_feb=excluded.seasonal_feb,
            seasonal_mar=excluded.seasonal_mar, seasonal_apr=excluded.seasonal_apr,
            seasonal_may=excluded.seasonal_may, seasonal_jun=excluded.seasonal_jun,
            seasonal_jul=excluded.seasonal_jul, seasonal_aug=excluded.seasonal_aug,
            seasonal_sep=excluded.seasonal_sep, seasonal_oct=excluded.seasonal_oct,
            seasonal_nov=excluded.seasonal_nov, seasonal_dec=excluded.seasonal_dec,
            dist_3m_high_pct=excluded.dist_3m_high_pct, dist_3m_low_pct=excluded.dist_3m_low_pct,
            fetched_at=CURRENT_TIMESTAMP
    """, (
        symbol, today_str,
        f.get("stock_ret_1m"), f.get("stock_ret_3m"), f.get("stock_ret_6m"),
        f.get("stock_ret_1y"), f.get("stock_ret_3y"), f.get("stock_ret_5y"),
        f.get("nifty_ret_1m"), f.get("nifty_ret_3m"), f.get("nifty_ret_6m"),
        f.get("nifty_ret_1y"), f.get("nifty_ret_3y"), f.get("nifty_ret_5y"),
        f.get("ind_ret_1m"), f.get("ind_ret_3m"), f.get("ind_ret_6m"),
        f.get("alpha_nifty_1m"), f.get("alpha_nifty_3m"), f.get("alpha_nifty_6m"),
        f.get("alpha_ind_1m"), f.get("alpha_ind_3m"),
        *[f.get(f"seasonal_{m}") for m in ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]],
        f.get("dist_3m_high_pct"), f.get("dist_3m_low_pct"),
    ))
    con.commit()


def backfill_technical_signals(symbol: str, f: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            tl_vs_nifty_1m       = COALESCE(?, tl_vs_nifty_1m),
            tl_vs_nifty_3m       = COALESCE(?, tl_vs_nifty_3m),
            tl_vs_nifty_6m       = COALESCE(?, tl_vs_nifty_6m),
            tl_vs_ind_1m         = COALESCE(?, tl_vs_ind_1m),
            tl_vs_ind_3m         = COALESCE(?, tl_vs_ind_3m),
            tl_seasonal_month_5y = COALESCE(?, tl_seasonal_month_5y),
            tl_dist_3m_high_pct  = COALESCE(?, tl_dist_3m_high_pct),
            tl_dist_3m_low_pct   = COALESCE(?, tl_dist_3m_low_pct)
        WHERE symbol = ?
    """, (
        f.get("alpha_nifty_1m"), f.get("alpha_nifty_3m"), f.get("alpha_nifty_6m"),
        f.get("alpha_ind_1m"), f.get("alpha_ind_3m"),
        f.get("tl_seasonal_month_5y"),
        f.get("dist_3m_high_pct"), f.get("dist_3m_low_pct"),
        symbol,
    ))
    con.commit()


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = _load_stocks(args.symbol, con)
    if not stocks:
        print("[TLPriceAnalysis] No stocks with tlid found.")
        return

    print(f"[TLPriceAnalysis] Fetching price-performance-analysis for {len(stocks)} stocksâ€¦")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today()
    today_str = today.isoformat()
    ok = 0

    for i, (symbol, tlid) in enumerate(stocks, 1):
        body = _fetch(tlid, session)
        if body is None:
            print(f"  [{i}/{len(stocks)}] {symbol}: no data")
            time.sleep(RATE_LIMIT_SEC)
            continue

        f = extract_features(body, today)
        upsert_row(symbol, today_str, f, con)
        backfill_technical_signals(symbol, f, con)

        alpha_str    = f"Î±Nifty1M={f.get('alpha_nifty_1m','?')}% Î±Nifty3M={f.get('alpha_nifty_3m','?')}%"
        ind_str      = f"Î±Ind1M={f.get('alpha_ind_1m','?')}%"
        seasonal_str = f"season={f.get('tl_seasonal_month_5y','?')}%"
        print(f"  [{i}/{len(stocks)}] {symbol}: {alpha_str} | {ind_str} | {seasonal_str}")
        ok += 1
        time.sleep(RATE_LIMIT_SEC)

    print(f"[TLPriceAnalysis] Done. {ok}/{len(stocks)} stocks.")
    con.close()


if __name__ == "__main__":
    main()
