#!/usr/bin/env python3
"""
NiftyTrader Live Screener Job
==============================
Captures NiftyTrader's live screener data with each filter selected once,
stores results in niftytrader_live_screener_snapshots table.

Design:
- Sends ONE request per filter (each filter individually set to True)
- Uses ThreadPoolExecutor for parallel requests (configurable concurrency)
- Captures trade_date, captured_at timestamp with each row
- Append-only: no overwrites, each capture is a new cohort
- Only runs during market hours (09:15-15:30 IST, Mon-Fri)

Schedule: Every 15 minutes during market hours
  Cron: '*/15 9-15 * * 1-5' (09:00-15:59 IST, Mon-Fri)
  Actual market hours: 09:15-15:30 IST (checked at runtime)

Run:
  python niftytrader_live_screener_job.py                    # all filters
  python niftytrader_live_screener_job.py --concurrency 5    # parallel workers
  python niftytrader_live_screener_job.py --dry-run          # fetch only, no DB write
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

# Ensure src/server is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db_compat import connect, query_scalar

# ---------------------------------------------------------------------------
# NiftyTrader API configuration
# ---------------------------------------------------------------------------

NT_LIVE_SCREENER_URL = "https://www.niftytrader.in/api/niftytrader/Screener/live-market-filter-data"

NT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
}

# Default payload template -- all filters False, industry/watchlist empty
DEFAULT_PAYLOAD = {
    "todayNR7": False, "yesterdayNR7": False,
    "todayGapUP": False, "todayGapDown": False,
    "yesterdayGapUP": False, "yesterdayGapDown": False,
    "todayStockOpenHigh": False, "todayStockOpenLow": False,
    "yesterdayStockOpenHigh": False, "yesterdayStockOpenLow": False,
    "weeklyStockOpenHigh": False, "weeklyStockOpenLow": False,
    "orb5minHigh": False, "orb5minLow": False,
    "prevOrb5minLow": False, "prevOrb5minHigh": False,
    "range20DayUP": False, "range50DayUP": False, "range200DayUP": False,
    "range52WeekHigh": False, "range20DayDown": False, "range50DayDown": False,
    "range200DayDown": False, "range52WeekLow": False,
    "higherHighHigherLow": False, "lowerHighLowerLow": False,
    "insideDay": False, "outsideDay": False,
    "range0To100": False, "range100To500": False, "range500To1000": False,
    "range1000To2000": False, "rangeAbove2000": False,
    "todayBullishHigh": False, "todayBearishLow": False, "todayNetural": False,
    "yesterdayBullishHigh": False, "yesterdayBearishLow": False, "yesterdayNetural": False,
    "todayAbove20SMA": False, "todayBelow20SMA": False,
    "todayAbove50SMA": False, "todayBelow50SMA": False,
    "todayAbove200SMA": False, "todayBelow200SMA": False,
    "yesterdayAbove20SMA": False, "yesterdayBelow20SMA": False,
    "yesterdayAbove50SMA": False, "yesterdayBelow50SMA": False,
    "yesterdayAbove200SMA": False, "yesterdayBelow200SMA": False,
    "todayHighVolumeDay": False,
    "vwapAbove": False, "vwapBelow": False,
    "marketCapBelow1000": False, "marketCap5000To20000": False,
    "marketCapAbove50000": False, "marketCap1000To5000": False,
    "marketCap20000To50000": False,
    "stockPEBelow5": False, "stockPE10To20": False, "stockPE50To100": False,
    "stockPE5To10": False, "stockPE20To50": False, "stockPEAbove100": False,
    "dividendYield0To1": False, "dividendYield2To5": False,
    "dividendYield1To2": False, "dividendYieldAbove5": False,
    "roceBelow5": False, "roce10To20": False, "roce50To70": False,
    "roce5To10": False, "roce20To50": False, "roce70To100": False,
    "roeBelow0": False, "roe10To20": False, "roeAbove50": False,
    "roe0To10": False, "roe20To50": False,
    "salesGrowthBelow0": False, "salesGrowth5To10": False,
    "salesGrowth15To20": False, "salesGrowth0To5": False,
    "salesGrowth10To15": False, "salesGrowthAbove20": False,
    "piotroskiScore0To2": False, "piotroskiScore3To7": False,
    "piotroskiScore8To9": False,
    "nifty50Stocks": False, "fnoStocks": False,
    "financial": False, "nonFinancial": False,
    "industry": "", "maxPainAbove": False, "maxPainBelow": False,
    "watchlistName": "",
    "aboveCPR": False, "belowCPR": False, "insideCPR": False,
    "screenerGroupName": "",
}

# Filter catalog: each filter name -> the payload key to set True
# These are the filters we capture individually (one per request)
# Covers ALL filters from NiftyTrader's live-market-filter-data endpoint
FILTER_CATALOG = [
    # -- Candlestick & Range --
    "todayNR7", "yesterdayNR7",
    "todayGapUP", "todayGapDown",
    "yesterdayGapUP", "yesterdayGapDown",
    "todayStockOpenHigh", "todayStockOpenLow",
    "weeklyStockOpenHigh", "weeklyStockOpenLow",
    "orb5minHigh", "orb5minLow",
    "range52WeekHigh", "range52WeekLow",
    "higherHighHigherLow", "lowerHighLowerLow",
    "insideDay", "outsideDay",
    # -- Moving Averages --
    "todayAbove20SMA", "todayBelow20SMA",
    "todayAbove50SMA", "todayBelow50SMA",
    "todayAbove200SMA", "todayBelow200SMA",
    "yesterdayAbove20SMA", "yesterdayBelow20SMA",
    "yesterdayAbove50SMA", "yesterdayBelow50SMA",
    "yesterdayAbove200SMA", "yesterdayBelow200SMA",
    # -- Volume & VWAP --
    "todayHighVolumeDay",
    "vwapAbove", "vwapBelow",
    # -- Market Cap --
    "marketCapBelow1000", "marketCap1000To5000", "marketCap5000To20000",
    "marketCap20000To50000", "marketCapAbove50000",
    # -- Valuation (P/E) --
    "stockPEBelow5", "stockPE5To10", "stockPE10To20", "stockPE20To50",
    "stockPE50To100", "stockPEAbove100",
    # -- Dividend Yield --
    "dividendYield0To1", "dividendYield1To2", "dividendYield2To5", "dividendYieldAbove5",
    # -- ROCE --
    "roceBelow5", "roce5To10", "roce10To20", "roce20To50", "roce50To70", "roce70To100",
    # -- ROE --
    "roeBelow0", "roe0To10", "roe10To20", "roe20To50", "roeAbove50",
    # -- Sales Growth --
    "salesGrowthBelow0", "salesGrowth0To5", "salesGrowth5To10",
    "salesGrowth10To15", "salesGrowth15To20", "salesGrowthAbove20",
    # -- Piotroski Score --
    "piotroskiScore0To2", "piotroskiScore3To7", "piotroskiScore8To9",
    # -- Index/Universe --
    "nifty50Stocks", "fnoStocks",
]


# Validate that all filters in FILTER_CATALOG exist in DEFAULT_PAYLOAD
_missing = [f for f in FILTER_CATALOG if f not in DEFAULT_PAYLOAD]
if _missing:
    raise ValueError(f"FILTER_CATALOG contains keys not in DEFAULT_PAYLOAD: {_missing}")

# Market hours (IST)
MARKET_OPEN_HOUR = 9
MARKET_OPEN_MIN = 15
MARKET_CLOSE_HOUR = 15
MARKET_CLOSE_MIN = 30

# Request timeout (seconds)
REQUEST_TIMEOUT = 15

# Max retries per filter
MAX_RETRIES = 2


def is_market_hours():
    """Check if current time is within market hours (09:15-15:30 IST, Mon-Fri)."""
    # Get current IST time (UTC+5:30)
    now_utc = datetime.utcnow()
    now_ist = now_utc + timedelta(hours=5, minutes=30)

    # Check weekday (0=Mon, 5=Sat, 6=Sun)
    if now_ist.weekday() >= 5:
        return False

    # Check time
    current_minutes = now_ist.hour * 60 + now_ist.minute
    open_minutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN
    close_minutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN

    return open_minutes <= current_minutes <= close_minutes


def get_trade_date():
    """Get the logical trade date (today's date if market is open)."""
    now_utc = datetime.utcnow()
    now_ist = now_utc + timedelta(hours=5, minutes=30)
    return now_ist.strftime("%Y-%m-%d")


def get_nt_bearer_token():
    """Read the NiftyTrader JWT from app_settings."""
    try:
        token = query_scalar(
            "SELECT value FROM app_settings WHERE key = 'niftytrader_auth_token'"
        )
        return token
    except Exception as e:
        print(f"[NT_LIVE] token lookup failed ({e}); job will be skipped", file=sys.stderr)
        return None


def build_filter_payload(filter_name):
    """Build a payload with only the specified filter set to True."""
    payload = dict(DEFAULT_PAYLOAD)
    payload[filter_name] = True
    return payload


def extract_symbol(row):
    """Extract NSE symbol from a row dict."""
    for key in ("symbol_name", "symbol", "nse_symbol", "nsesymbol", "scrip", "security"):
        val = row.get(key)
        if isinstance(val, str) and val.strip():
            sym = val.strip().upper()
            if len(sym) <= 20 and " " not in sym:
                return sym
    return None


def extract_float(row, *keys):
    """Extract a float value from a row dict using multiple possible keys."""
    for key in keys:
        val = row.get(key)
        if val is not None:
            try:
                return float(str(val).replace(",", "").replace("%", "").strip())
            except (TypeError, ValueError):
                continue
    return None


def fetch_single_filter(session, filter_name, bearer_token):
    """
    Fetch live screener data for a single filter.
    Returns (filter_name, rows, error) tuple.
    """
    payload = build_filter_payload(filter_name)
    headers = {**NT_HEADERS, "Authorization": f"Bearer {bearer_token}"}

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.post(
                NT_LIVE_SCREENER_URL,
                headers=headers,
                data=json.dumps(payload),
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 401:
                return (filter_name, [], "unauthorized (token expired/no Prime)")
            resp.raise_for_status()
            js = resp.json()

            # Extract rows from response
            data = js.get("resultData") if isinstance(js, dict) else None
            if isinstance(data, dict):
                data = data.get("data")

            if not isinstance(data, list):
                return (filter_name, [], f"unexpected response shape: {type(data).__name__}")

            rows = []
            for i, row in enumerate(data, 1):
                if not isinstance(row, dict):
                    continue
                sym = extract_symbol(row)
                if not sym:
                    continue
                pct = extract_float(row, "change_per", "change_percent", "percentchange")
                rows.append({
                    "symbol": sym,
                    "rank": i,
                    "pct_change": pct,
                    "payload": row,
                })

            return (filter_name, rows, None)

        except Exception as e:
            if attempt == MAX_RETRIES:
                return (filter_name, [], str(e))
            time.sleep(0.5 * attempt)  # brief backoff

    return (filter_name, [], "max retries exceeded")


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

DDL = """
CREATE TABLE IF NOT EXISTS niftytrader_live_screener_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filter_name     TEXT NOT NULL,
    trade_date      TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    rank            INTEGER,
    pct_change      REAL,
    captured_at     TEXT NOT NULL,
    payload_json    TEXT,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP
)
"""

INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_nt_live_screener_filter_date
    ON niftytrader_live_screener_snapshots (filter_name, trade_date, captured_at)
"""


def ensure_schema(conn):
    """Create table and index if they don't exist."""
    cur = conn.cursor()
    cur.execute(DDL)
    try:
        cur.execute(INDEX_DDL)
    except Exception:
        pass  # index may already exist
    conn.commit()


def persist_results(conn, filter_name, trade_date, captured_at, rows):
    """Insert rows into the database. Append-only (no upsert)."""
    if not rows:
        return 0

    cur = conn.cursor()
    sql = """
        INSERT INTO niftytrader_live_screener_snapshots
            (filter_name, trade_date, symbol, rank, pct_change, captured_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """
    records = [
        (
            filter_name,
            trade_date,
            row["symbol"],
            row["rank"],
            row["pct_change"],
            captured_at,
            json.dumps(row["payload"], default=str),
        )
        for row in rows
    ]
    cur.executemany(sql, records)
    conn.commit()
    return len(records)


# ---------------------------------------------------------------------------
# Main job
# ---------------------------------------------------------------------------

def run_job(concurrency=5, dry_run=False):
    """
    Main job entry point.
    1. Check market hours
    2. Get bearer token
    3. Fetch each filter in parallel
    4. Persist results
    """
    from curl_cffi import requests as cffi_requests

    # Step 1: Check market hours
    if not is_market_hours():
        print("[NT_LIVE] Outside market hours (09:15-15:30 IST, Mon-Fri). Skipping.")
        return

    # Step 2: Get bearer token
    bearer_token = get_nt_bearer_token()
    if not bearer_token:
        # Exit non-zero: this is NOT a skip. Outside market hours there is genuinely nothing to
        # capture, but a missing bearer token during market hours means every filter this run
        # should have captured was silently dropped -- an auth/credential failure wearing a
        # skip's clothing. Returning 0 here let the BullMQ step stamp
        # recordHeartbeat('nt-live-filter-capture', 'success') over whatever the last real run
        # reported (recurring-bugs.md's skip-path-stamped-as-success class, 6 recurrences).
        print("[NT_LIVE] No bearer token available - cannot capture. Failing loudly rather "
              "than reporting an empty run as success.", file=sys.stderr)
        sys.exit(1)

    trade_date = get_trade_date()
    captured_at = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[NT_LIVE] Starting capture for trade_date={trade_date}, filters={len(FILTER_CATALOG)}, concurrency={concurrency}")

    # Step 3: Fetch each filter in parallel
    session = cffi_requests.Session(impersonate="chrome")
    results = {}
    total_rows = 0
    failed_filters = []

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_to_filter = {
            executor.submit(fetch_single_filter, session, fname, bearer_token): fname
            for fname in FILTER_CATALOG
        }

        for future in as_completed(future_to_filter):
            fname = future_to_filter[future]
            try:
                filter_name, rows, error = future.result()
                if error:
                    print(f"  [NT_LIVE] {fname}: FAILED ({error})")
                    failed_filters.append((fname, error))
                else:
                    results[filter_name] = rows
                    total_rows += len(rows)
                    print(f"  [NT_LIVE] {fname}: {len(rows)} rows")
            except Exception as e:
                print(f"  [NT_LIVE] {fname}: EXCEPTION ({e})")
                failed_filters.append((fname, str(e)))

    # Step 4: Persist results
    if dry_run:
        print(f"[NT_LIVE] DRY RUN: {total_rows} rows captured, {len(failed_filters)} filters failed. NOT writing to DB.")
        return

    conn = connect()
    try:
        ensure_schema(conn)
        total_written = 0
        for filter_name, rows in results.items():
            written = persist_results(conn, filter_name, trade_date, captured_at, rows)
            total_written += written
        print(f"[NT_LIVE] Persisted {total_written} rows across {len(results)} filters. {len(failed_filters)} filters failed.")
    finally:
        conn.close()

    # Summary
    if failed_filters:
        print(f"[NT_LIVE] Failed filters:")
        for fname, err in failed_filters:
            print(f"  - {fname}: {err}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NiftyTrader Live Screener Capture Job")
    parser.add_argument("--concurrency", type=int, default=5, help="Number of parallel workers (default: 5)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch only, do not write to DB")
    args = parser.parse_args()

    run_job(concurrency=args.concurrency, dry_run=args.dry_run)
