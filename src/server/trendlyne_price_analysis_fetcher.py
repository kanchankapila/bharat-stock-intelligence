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

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class TrendlynePriceAnalysisFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class TrendlynePriceAnalysisFetcherBaseFetcher(BaseFetcher[TrendlynePriceAnalysisFetcherSchema]):
    fetcher_name = 'TrendlynePriceAnalysisFetcher'
    domain = 'trendlyne.com'
    schema = TrendlynePriceAnalysisFetcherSchema
    min_interval_sec = 0.5


import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

import requests

import tl_fetch

from db_compat import connect
from as_of import logical_write_floor
from fetch_utils import (retry_get, FetchTracker, filter_numeric_tlids,
                         TRENDLYNE_MAX_CONCURRENT, cap_to_run_budget)
import sys

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
# Reduced from 15/0.5s 2026-08-09: the last two scheduled runs (07-28, 08-04) both hit 100%
# failure -- live-reproduced by hand the same day, a burst of concurrent requests to THIS
# specific endpoint (trendlyne_adv_tech_fetcher.py's sibling job, identical batch settings,
# succeeded both times) reliably trips Trendlyne's WAF into serving a "Human Verification"
# page (405) for every request, including previously-working ones, for the rest of the run.
# Lower concurrency + wider gap to stay under whatever burst threshold this endpoint enforces.
# ponytail: no adaptive backoff/proxy rotation -- if this still trips the WAF, the run now
# fails loud (FetchTracker/job_heartbeat) instead of silently, so the next tightening is a
# data-driven follow-up, not a guess made now.
# Was 5 -- AWS WAF returns 405/captcha for the rest of the run when more than 3
# requests are in flight at once. Measured, see TRENDLYNE_MAX_CONCURRENT in fetch_utils.py.
BATCH_SIZE = TRENDLYNE_MAX_CONCURRENT
BATCH_GAP_SEC  = 2.0

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
        r = retry_get(session, url, params={"format": "json"}, timeout=15)
        data = r.json()
        if (data.get("head") or {}).get("status") != "0":
            return None
        return data.get("body") or {}
    except Exception as e:
        print(f"  [{tlid}] price-analysis error: {e}", file=sys.stderr)
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
    # Live response rows (2026-08-06): Day, Week, Month, Qtr, Half Year, 1 Yr, 3 Yr, 5 Yr, 10 Yr.
    # The old bare `"3" in label` fallback also matched "3 Yr" (which sorts AFTER "Qtr" in the
    # table), silently overwriting the correct 3-month distance with the 3-YEAR distance on every
    # successful run since this column was built -- excluding any "Yr" label keeps the fallback
    # for a differently-labeled "3 Mth"/"3M" response without matching "3 Yr"/"3 Years".
    dd = body.get("returnsDeepDive", {})
    for row in dd.get("tableData", []):
        label = str(row[IDX_DD_PERIOD]) if len(row) > IDX_DD_PERIOD else ""
        if label == "Qtr" or ("3" in label and "Yr" not in label):
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


def backfill_technical_signals(symbol: str, today_str: str, f: dict, con) -> None:
    """date >= ? ELSE NULL guard added 2026-07-19 -- this previously had no date filter
    (`WHERE symbol = ?`), smearing today's snapshot across a symbol's entire history via
    COALESCE-fills-null-once-then-frozen-forever. Same bug class found in
    mc_pricefeed_fetcher.py and trendlyne_adv_tech_fetcher.py; see those for the full writeup."""
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            tl_vs_nifty_1m       = CASE WHEN date >= ? THEN COALESCE(?, tl_vs_nifty_1m)       ELSE NULL END,
            tl_vs_nifty_3m       = CASE WHEN date >= ? THEN COALESCE(?, tl_vs_nifty_3m)       ELSE NULL END,
            tl_vs_nifty_6m       = CASE WHEN date >= ? THEN COALESCE(?, tl_vs_nifty_6m)       ELSE NULL END,
            tl_vs_ind_1m         = CASE WHEN date >= ? THEN COALESCE(?, tl_vs_ind_1m)         ELSE NULL END,
            tl_vs_ind_3m         = CASE WHEN date >= ? THEN COALESCE(?, tl_vs_ind_3m)         ELSE NULL END,
            tl_seasonal_month_5y = CASE WHEN date >= ? THEN COALESCE(?, tl_seasonal_month_5y) ELSE NULL END,
            tl_dist_3m_high_pct  = CASE WHEN date >= ? THEN COALESCE(?, tl_dist_3m_high_pct)  ELSE NULL END,
            tl_dist_3m_low_pct   = CASE WHEN date >= ? THEN COALESCE(?, tl_dist_3m_low_pct)   ELSE NULL END
        WHERE symbol = ?
    """, (
        today_str, f.get("alpha_nifty_1m"), today_str, f.get("alpha_nifty_3m"),
        today_str, f.get("alpha_nifty_6m"),
        today_str, f.get("alpha_ind_1m"), today_str, f.get("alpha_ind_3m"),
        today_str, f.get("tl_seasonal_month_5y"),
        today_str, f.get("dist_3m_high_pct"), today_str, f.get("dist_3m_low_pct"),
        symbol,
    ))
    con.commit()


def _load_stocks(symbol_filter: str | None, con, skip_done_for_date=None) -> list[tuple[str, str]]:
    """Return [(symbol, tlid), ...] scoped to the NSE master list only (nse_stocks.tlid).
    No trendlyne_screener_stocks fallback — that table carries non-NSE-master symbols
    (junk/delisted/BSE-only tickers) which pulled the universe well past NSE coverage.
    """
    cur = con.cursor()
    cur.execute("""
        SELECT symbol, tlid::TEXT AS tlid FROM nse_stocks
        WHERE symbol IS NOT NULL AND tlid IS NOT NULL AND tlid::TEXT != ''
        ORDER BY symbol
    """)
    rows = [(r[0], str(r[1])) for r in cur.fetchall() if r[0] is not None]
    if symbol_filter:
        rows = [(s, t) for s, t in rows if s.upper() == symbol_filter.upper()]
    # Same permanent-404 filter as trendlyne_adv_tech_fetcher.py's sibling loader.
    rows, _ = filter_numeric_tlids(rows, "TLPriceAnalysis")
    # Resume, mirroring the sibling loader in trendlyne_adv_tech_fetcher.py. Without this the
    # run always restarted at the same alphabetical position, so every run re-fetched the same
    # leading ~100 symbols, tripped Trendlyne's WAF (see TRENDLYNE_MAX_CONCURRENT in
    # fetch_utils.py) and aborted -- leaving coverage pinned at 145/2234 no matter how often it
    # ran. The sibling, which already had this, reached 2234/2234 by resuming across runs.
    if skip_done_for_date:
        cur.execute(
            "SELECT symbol FROM trendlyne_price_analysis WHERE date = ?",
            (skip_done_for_date,),
        )
        done = {r[0] for r in cur.fetchall()}
        if done:
            before = len(rows)
            rows = [(s, t) for s, t in rows if s not in done]
            print(f"[TLPriceAnalysis] Resuming: {before - len(rows)} of {before} stocks already "
                  f"fetched for {skip_done_for_date}, {len(rows)} remaining.")
        # Order the remaining work least-recently-fetched first, NOT alphabetically.
        #
        # Unlike the sibling loaders, this fetcher's skip key is the real calendar date (its
        # `date` column is a calendar date -- extract_features needs it for the seasonal-month
        # lookup), so `done` empties at every midnight and the run restarts from 'A'. Combined
        # with a per-run budget below the universe size that starves a fixed tail forever:
        # the catch-up rotation gives this script ~18 slices/day (one per 80 min) x 110 rows
        # = 1,980 < 2,234 mapped tlids, so ranks ~1,981+ were re-cut from every run of every
        # day and never fetched at all. Measured live 2026-08-17: the day's coverage was a
        # contiguous alphabetical prefix, universe ranks 1-692 with a single gap inside it,
        # and a rolling 3-day window held 691/2,234 distinct symbols.
        #
        # Sorting by each symbol's own last-fetched date (never-fetched sorts first, symbol
        # breaks ties so the order stays deterministic) makes the shortfall rotate instead of
        # falling on the same names, which is also what lets the rolling-window coverage check
        # in dataQualityChecks.ts reach 100% -- under alphabetical order it was capped at
        # 1,980/2,234 = 88.6% by construction, no matter how healthy the endpoint was.
        cur.execute("SELECT symbol, MAX(date) AS last_date FROM trendlyne_price_analysis GROUP BY symbol")
        last_fetched = {r[0]: (r[1] or "") for r in cur.fetchall()}
        rows.sort(key=lambda row: (last_fetched.get(row[0], ""), row[0]))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    # Must be the ISO *string*, not a date object: trendlyne_price_analysis.date is TEXT in
    # production (checked in information_schema, not assumed), and upsert_row writes today_str.
    # Passing a date here raises `operator does not exist: text = date` on Postgres.
    stocks = _load_stocks(
        args.symbol, con,
        skip_done_for_date=None if args.symbol else date.today().isoformat(),
    )
    if not stocks:
        print("[TLPriceAnalysis] No stocks with tlid found.")
        return

    stocks = cap_to_run_budget(stocks, "TLPriceAnalysis", requests_per_row=1)
    print(f"[TLPriceAnalysis] Fetching price-performance-analysis for {len(stocks)} stocks in batches of {BATCH_SIZE} ({BATCH_GAP_SEC}s gap)...")
    # 2026-08-26: curl_cffi Chrome-TLS-impersonated session via tl_fetch (see
    # trendlyne_adv_tech_fetcher.py for the rationale); HEADERS applied only on the
    # plain-requests fallback so Scrapling's own browser-consistent header set wins.
    session = tl_fetch.create_session()
    if not isinstance(session, tl_fetch.TLSession):
        session.headers.update(HEADERS)
    today = date.today()  # real calendar date -- extract_features() needs this for the seasonal-month lookup
    # But the technical_signals UPDATE below needs the last COMPLETED trading session, not the
    # calendar date: this job runs Tuesday evening (trendlyne-midweek), and any day the grid-ensurer
    # hasn't yet created date.today()'s row (e.g. before it runs that day, or on any non-trading day
    # this script is re-run ad-hoc) leaves "date >= today_str" matching zero rows while the ELSE
    # branch nulls every existing row -- same bug found in trendlyne_fundamentals_fetcher.py /
    # mf_holdings_fetcher.py / financial_ratios_fetcher.py.
    anchor_str = logical_write_floor(con, fallback=today.isoformat())
    today_str = today.isoformat()
    ok = 0
    done = 0
    # Every stock returning "no data" (found live 2026-07-28: all 1822/1822 stocks silently
    # empty, script still exited 0 and logged "execution completed") must not look identical to
    # a healthy run -- FetchTracker exits non-zero once the failure rate crosses its threshold,
    # so pythonRunner/T.run() surfaces it as a real job failure instead of a silent no-op.
    # abort_after_consecutive_fails=20 (2026-08-13): this endpoint has been WAF-blocking on
    # request 1 of every run (405 on every retry) and grinding through all ~2234 stocks anyway
    # until the outer runPython timeout kills it ~52min in -- see fetch_utils.FetchTracker.
    tracker = FetchTracker("trendlyne_price_analysis_fetcher", abort_after_consecutive_fails=20)

    def _fetch_one(args):
        symbol, tlid = args
        return symbol, tlid, _fetch(tlid, session)

    for batch_start in range(0, len(stocks), BATCH_SIZE):
        batch = stocks[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, item) for item in batch]
            for fut in as_completed(futures):
                symbol, tlid, body = fut.result()
                done += 1
                if body is None:
                    print(f"  [{done}/{len(stocks)}] {symbol}: no data")
                    tracker.record(symbol, ok=False)
                    continue
                f = extract_features(body, today)
                upsert_row(symbol, today_str, f, con)
                backfill_technical_signals(symbol, anchor_str, f, con)
                alpha_str    = f"aNifty1M={f.get('alpha_nifty_1m','?')}% aNifty3M={f.get('alpha_nifty_3m','?')}%"
                ind_str      = f"aInd1M={f.get('alpha_ind_1m','?')}%"
                seasonal_str = f"season={f.get('tl_seasonal_month_5y','?')}%"
                print(f"  [{done}/{len(stocks)}] {symbol}: {alpha_str} | {ind_str} | {seasonal_str}")
                ok += 1
                tracker.record(symbol, ok=True)
        time.sleep(BATCH_GAP_SEC)

    print(f"[TLPriceAnalysis] Done. {ok}/{len(stocks)} stocks.")
    con.close()
    tracker.finish()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
