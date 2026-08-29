#!/usr/bin/env python3
"""
Cross-sectional factor screener snapshot (PE/ROE/ROCE/D-E/growth/margin/1m-return) from
InvestSights' `advanced-screener/query` endpoint.

WHY THIS EXISTS
---------------
Onboarded via `onboard-data-source`, 2026-08-13 batch pass. **The response schema does NOT
match what the batch's original capture suggested** (graham_number/industry_pe/earning_power/
avg_roe_3y-5y/etc.) -- live-verified 2026-08-13 that those fields do not exist on this
endpoint under any request shape tried (`fields`/`columns` request params are silently
ignored; the response is a fixed 13-column shape regardless). Built against what the endpoint
ACTUALLY returns, not the earlier assumption -- see `data-sources.md`'s "never guess a
response shape" mandate.

    POST https://investsights.in/api/v2/advanced-screener/query
    body: {"filters": {}, "limit": 100, "offset": N}

VERIFIED LIVE BEHAVIOUR (2026-08-13)
--------------------------------------
* `filters` must be a JSON object (`{}` works; `[]` 422s: "Input should be a valid
  dictionary"). A `{"symbols": [...]}` key is silently ignored -- passing it returns the exact
  same rows as an empty filter, so this fetcher does not attempt server-side symbol filtering.
* `limit` is silently capped at 100 server-side (`limit: 10000` still returns exactly 100
  rows) -- pagination is mandatory. `offset` works and the ranking is stable (market_cap
  DESC, confirmed: offset=0 row 1 RELIANCE ... offset=5 row 1 TCS, consistent single global
  ranking, no duplicate/skip observed across a probe).
* `total: 5377` is far larger than this platform's ~2000-stock NSE universe -- InvestSights'
  screener spans BSE-only/SME/delisted names too. This fetcher resolves each row's `symbol`
  against `nse_stocks` and logs (not silently drops) the unresolved count per the mandated
  resolution-order rule; expect a large non-match fraction, that's the provider's universe
  being wider than ours, not a bug.
* This is a QUERY endpoint, not a per-stock endpoint -- ticker resolution here means "is this
  row's bare symbol one of ours," not the autocomplete-cache pattern used elsewhere.
* No per-row date; `last_synced` is one timestamp for the whole payload, refreshed by
  InvestSights on their own cadence. Stored keyed on `(symbol, fetched_date)` using this
  platform's own logical trading date (as_of discipline), not `last_synced` itself.

Run:
  python investsights_factor_scores_fetcher.py
"""

import polars as pl
import sys
import time

import requests

from db_compat import connect, ConnWrapper
from as_of import logical_trading_date

URL = "https://investsights.in/api/v2/advanced-screener/query"
SOURCE = "investsights"
PAGE_SIZE = 100
RATE_LIMIT_SEC = 0.2

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
}


def _log(m):
    print(f"[InvestsightsFactorScores] {m}", flush=True)


def _num(raw, k):
    v = raw.get(k)
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def fetch_page(session: requests.Session, offset: int) -> dict:
    # ponytail: no retry_post helper exists in fetch_utils.py (only retry_get) -- matches the
    # un-retried session.post() precedent in marketsmojo_financials_fetcher.py/fintrend_fetcher.py
    # rather than adding a new shared helper for one caller.
    resp = session.post(URL, json={"filters": {}, "limit": PAGE_SIZE, "offset": offset}, timeout=20)
    resp.raise_for_status()
    return resp.json()


def fetch_all_rows(session: requests.Session, max_rows: int = 6000) -> list[dict]:
    """Paginate the full screener. Stops on an empty page or once `total` is reached --
    whichever comes first, so a mid-fetch total-count drift can't spin forever."""
    rows: list[dict] = []
    offset = 0
    total = None
    while offset < max_rows:
        payload = fetch_page(session, offset)
        if not isinstance(payload, dict) or not payload.get("success"):
            break
        page = payload.get("data") or []
        if not page:
            break
        rows.extend(page)
        total = payload.get("total")
        offset += len(page)
        if total is not None and offset >= total:
            break
        time.sleep(RATE_LIMIT_SEC)
    return rows


def parse_row(raw: dict, fetched_date: str) -> dict | None:
    symbol = (raw.get("symbol") or "").strip().upper()
    if not symbol:
        return None
    return {
        "symbol": symbol, "fetched_date": fetched_date,
        "company_name": raw.get("company_name"), "sector": raw.get("sector"),
        "market_cap": _num(raw, "market_cap"), "close_price": _num(raw, "close_price"),
        "change_pct": _num(raw, "change_pct"), "pe_ratio": _num(raw, "pe_ratio"),
        "roe": _num(raw, "roe"), "roce": _num(raw, "roce"),
        "debt_to_equity": _num(raw, "debt_to_equity"),
        "revenue_growth_yoy": _num(raw, "revenue_growth_yoy"),
        "net_profit_margin": _num(raw, "net_profit_margin"),
        "return_1m": _num(raw, "return_1m"),
        "source": SOURCE,
    }


COLS = ["symbol", "fetched_date", "company_name", "sector", "market_cap", "close_price",
        "change_pct", "pe_ratio", "roe", "roce", "debt_to_equity", "revenue_growth_yoy",
        "net_profit_margin", "return_1m", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS investsights_factor_scores (
            symbol TEXT NOT NULL, fetched_date TEXT NOT NULL,
            company_name TEXT, sector TEXT, market_cap REAL, close_price REAL,
            change_pct REAL, pe_ratio REAL, roe REAL, roce REAL, debt_to_equity REAL,
            revenue_growth_yoy REAL, net_profit_margin REAL, return_1m REAL, source TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, fetched_date)
        )
    """)
    conn.commit()


def store_rows(conn: ConnWrapper, rows: list[dict]) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    update_cols = [c for c in COLS if c not in ("symbol", "fetched_date")]
    updates = ", ".join(f"{c}=excluded.{c}" for c in update_cols)
    sql = (f"INSERT INTO investsights_factor_scores ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (symbol, fetched_date) DO UPDATE SET {updates}")
    for row in rows:
        conn.execute(sql, tuple(row[c] for c in COLS))
    conn.commit()
    return len(rows)


def run() -> dict:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    result = {"fetched": 0, "resolved": 0, "unresolved": 0, "stored": 0}
    try:
        ensure_schema(conn)
        fetched_date = logical_trading_date()
        raw_rows = fetch_all_rows(session)
        result["fetched"] = len(raw_rows)
        _log(f"fetched {len(raw_rows)} screener rows across pagination")

        nse_rows = conn.execute("SELECT symbol FROM nse_stocks").fetchall()
        nse_symbols = {(r["symbol"] if hasattr(r, "keys") else r[0]) for r in nse_rows}

        parsed = []
        for raw in raw_rows:
            row = parse_row(raw, fetched_date)
            if not row:
                continue
            if row["symbol"] in nse_symbols:
                result["resolved"] += 1
                parsed.append(row)
            else:
                result["unresolved"] += 1

        result["stored"] = store_rows(conn, parsed)
        _log(f"resolved {result['resolved']}/{result['fetched']} against nse_stocks "
             f"({result['unresolved']} unresolved -- provider universe is wider than ours), "
             f"stored {result['stored']}")
    finally:
        conn.close()
    return result


def main() -> int:
    result = run()
    return 0 if result["stored"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class InvestsightsFactorScoresFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class InvestsightsFactorScoresFetcherBaseFetcher(BaseFetcher[InvestsightsFactorScoresFetcherSchema]):
    fetcher_name = 'InvestsightsFactorScoresFetcher'
    domain = 'investsights.in'
    schema = InvestsightsFactorScoresFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
