#!/usr/bin/env python3
"""
Futures basis / roll-spread / PCR, from NDTV Profit — an independent cross-check for
fno_rollover_fetcher.py's NSE-bhavcopy-derived rollover metrics.

WHY THIS EXISTS
---------------
`fno_rollover_fetcher.py` derives rollover% and annualized cost-of-carry from NSE bhavcopy OI
data — correct, but a single source with no independent check. NDTV Profit computes and
publishes its own live basis/roll-spread/rollover%/PCR per stock, updated intraday
(`broadcasted-at` on every response). The 2026-08-06 urls.txt analysis flagged this endpoint as
"confirmed dead" by an earlier pass, then "confirmed alive" by a later one — this session
resolved the contradiction for real: live-tested 2026-08-07 across the FULL 209-symbol F&O
universe at 12 concurrent workers, 209/209 HTTP 200, 207/209 with real (non-null) data (2 gaps
are plausible per-symbol coverage misses, not a systemic failure), 7.0s total runtime. A
plausibility cross-check against `fno_rollover.rollover_pct` for 5 symbols landed within ~1pp of
NDTV's own figure (RELIANCE: 15.51% bhavcopy-derived vs 16.63% NDTV-live, same order of
magnitude — not expected to match exactly, since the two use different methodologies and dates).

    https://www.ndtvprofit.com/api/v2/stock-summary?symbol={ticker}

`curl_cffi` Chrome-TLS impersonation is REQUIRED for this host — a plain `requests` call
returns non-JSON/blocked responses (confirmed both ways this session); this is why an earlier
pass judged the endpoint dead. Do not "simplify" this to plain `requests`.

SCOPE — deliberately F&O-eligible only, not the full ~2,400-stock universe
----------------------------------------------------------------------------
Futures contracts only exist for F&O-eligible stocks (`nse_stocks.fno_eligible = 1`, 209 symbols
as of 2026-08-07 — same universe `so_option_chain_fetcher.py`/`nt_dashboard_fetcher.py` already
use). There is no "whole universe" to expand this to: a non-F&O stock has no futures contract,
so basis/roll-spread/rollover%/PCR are structurally undefined for it, not merely unfetched.

FIELD SHAPE — verified live 2026-08-07
-----------------------------------------
    {"responseCode": 200, "data": {"basis": 5.2, "symbol": "RELIANCE", "spot-price": 1318.8,
     "1m-future": 1324, "2m-future": 1333, "roll-spread": 9, "roll-over-percentage": 16.63,
     "open-interest": 217909, "open-interest-change-percentage": -0.13, "put-call-ratio": 0.84},
     "broadcasted-at": "2026-08-07T09:40:09.480208041"}
A response with `data.symbol` null and every numeric field 0 means the stock has no active F&O
contract right now (verified live for DRCSYSTEMS, a small-cap outside the real F&O universe at
capture time) — not a fetch failure; skipped, not stored as zeros.

AS-OF DISCIPLINE
------------------
`broadcasted-at` is the provider's own timestamp; stored as-is for provenance. `date` (the
primary-key column, matching every sibling F&O table's convention) is the calendar date this
fetcher actually ran, not derived from `broadcasted-at` — this is a same-day intraday/EOD
snapshot fetcher, run once daily inside ml-daily-ops alongside the other F&O microstructure
fetchers, so "today" is always correct at call time (no midnight-crossing risk the way a
post-close batch step can have — see CLAUDE.md's "Midnight-Crossing Write-Target Bug" note for
why that distinction matters).

Run:
  python ndtv_fno_basis_fetcher.py
"""

import polars as pl
import sys
import threading

from curl_cffi import requests as cffi_req

from db_compat import connect, ConnWrapper, query_all
from fetch_utils import retry_get
from as_of import logical_trading_date

# One HTTP session per worker thread -- curl_cffi's Session is not guaranteed safe for
# concurrent requests on a single handle (documented gotcha, see intraday_fetcher.py's
# _get_session(), which this mirrors); a shared module-level session breaks once run() starts
# using ThreadPoolExecutor below.
_thread_local = threading.local()


def _get_session():
    sess = getattr(_thread_local, "session", None)
    if sess is None:
        sess = cffi_req.Session()
        sess.headers.update(HEADERS)
        _thread_local.session = sess
    return sess

API = "https://www.ndtvprofit.com/api/v2/stock-summary"
SOURCE = "ndtvprofit"
MAX_WORKERS = 12   # live-verified 2026-08-07: 209/209 HTTP 200 at this concurrency, 7.0s total

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.ndtvprofit.com/",
}


def _log(m):
    print(f"[NDTVBasis] {m}", flush=True)


def fetch_one(session, symbol: str) -> dict | None:
    """One symbol's stock-summary payload, or None on a non-200/malformed response. The ONLY
    fetch path -- tests call this."""
    resp = retry_get(session, API, params={"symbol": symbol}, timeout=15,
                      impersonate="chrome120")
    payload = resp.json()
    if not isinstance(payload, dict) or payload.get("responseCode") != 200:
        return None
    return payload


def parse_summary(symbol: str, payload: dict) -> dict | None:
    """One raw payload -> one ndtv_fno_basis row, or None if the stock has no active F&O
    contract right now (module docstring)."""
    data = (payload or {}).get("data") or {}
    if not data.get("symbol"):
        return None

    def num(k):
        v = data.get(k)
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return None if f != f else f   # NaN -> None; a NaN passes every coverage check

    return {
        "symbol": symbol,
        "spot_price": num("spot-price"),
        "future_1m": num("1m-future"),
        "future_2m": num("2m-future"),
        "basis": num("basis"),
        "roll_spread": num("roll-spread"),
        "rollover_pct": num("roll-over-percentage"),
        "open_interest": num("open-interest"),
        "oi_change_pct": num("open-interest-change-percentage"),
        "put_call_ratio": num("put-call-ratio"),
        "broadcasted_at": (payload.get("broadcasted-at") or None),
        "source": SOURCE,
    }


COLS = ["symbol", "date", "spot_price", "future_1m", "future_2m", "basis", "roll_spread",
        "rollover_pct", "open_interest", "oi_change_pct", "put_call_ratio",
        "broadcasted_at", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ndtv_fno_basis (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            spot_price REAL, future_1m REAL, future_2m REAL, basis REAL,
            roll_spread REAL, rollover_pct REAL, open_interest REAL,
            oi_change_pct REAL, put_call_ratio REAL,
            broadcasted_at TEXT, source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[2:])
    sql = (f"INSERT INTO ndtv_fno_basis ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (symbol, date) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def load_fno_symbols() -> list:
    rows = query_all("SELECT symbol FROM nse_stocks WHERE fno_eligible = 1 ORDER BY symbol")
    return [r["symbol"] for r in rows if r.get("symbol")]


def run(max_workers: int = MAX_WORKERS) -> int:
    from concurrent.futures import ThreadPoolExecutor

    symbols = load_fno_symbols()
    if not symbols:
        _log("no F&O-eligible symbols found in nse_stocks -- nothing to do")
        return 0

    today = logical_trading_date()

    def _fetch_and_parse(sym):
        try:
            payload = fetch_one(_get_session(), sym)
        except Exception as e:
            return (sym, None, str(e))
        if payload is None:
            return (sym, None, None)
        row = parse_summary(sym, payload)
        if row is not None:
            row["date"] = today
        return (sym, row, None)

    rows = []
    errors = 0
    no_contract = 0
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        for sym, row, err in ex.map(_fetch_and_parse, symbols):
            if err is not None:
                errors += 1
            elif row is None:
                no_contract += 1
            else:
                rows.append(row)

    conn = connect()
    try:
        ensure_schema(conn)
        n = store(conn, rows)
    finally:
        conn.close()

    _log(f"{len(symbols)} F&O symbols: {n} stored, {no_contract} no active contract, "
         f"{errors} fetch errors")
    return n


def main() -> int:
    n = run()
    if n == 0:
        _log("nothing stored this run")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class NdtvFnoBasisFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class NdtvFnoBasisFetcherBaseFetcher(BaseFetcher[NdtvFnoBasisFetcherSchema]):
    fetcher_name = 'NdtvFnoBasisFetcher'
    domain = 'general'
    schema = NdtvFnoBasisFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
