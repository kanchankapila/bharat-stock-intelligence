#!/usr/bin/env python3
"""
Per-stock corporate filings/announcements feed (results, presentations, concall transcripts,
credit ratings, annual reports) from InvestSights' market-pulse documents endpoint.

WHY THIS EXISTS
---------------
Onboarded via `onboard-data-source`, 2026-08-13 batch pass. **This fetcher targets a
different, and differently-shaped, endpoint than originally scoped** -- the batch's working
name for this item was "announcement-intelligence" with an assumed AI-enriched schema
(`announcement_category`/`headline_summary`/`impact_type`/`impact_magnitude`/
`price_implication`/`action_required`). Live-verified 2026-08-13 that no endpoint under that
name or shape exists; what IS live and confirmed is:

    GET https://investsights.in/api/v2/market-pulse/stock/{symbol}/documents/?limit=N

per `data-sources.md`'s "never guess a response shape" mandate, this fetcher is built against
the REAL response, not the assumed one. This is genuinely new data on this platform (a
filing-level feed with PDF links and per-filing AI-availability flags) and NOT a duplicate of
either `nse_filed_corporate_actions` (a calendar of corporate ACTIONS -- dividends/splits/
bonuses, not filings) or `concall_takeaways` (an AI-summarized concall TEXT, already covered
by the existing `investsights_concall_fetcher.py`) -- this table's `concall` category rows are
therefore stored as filing METADATA (PDF link, date) only, deliberately not the takeaway text,
to avoid overlap with that sibling fetcher.

RESPONSE SHAPE -- verified live, WEBELSOLAR, 2026-08-13
-----------------------------------------------------------
`{symbol, filings: {announcement: [...], presentation: [...], result: [...], concall: [...],
annual_report: [...], credit_rating: [...]}, concall_quarters: [...], ai_content: {...},
total}`. Each filing item: `{uid, source, category, symbol, title, description, pdf_link,
announcement_date, announcement_datetime, value, extra: {...}, has_ai_analysis,
has_ai_research}`. `filings` is a dict keyed by category -- this fetcher flattens all
categories into one row set, using each item's own `category` field (already present per-item,
so the dict key is redundant and not separately stored). `uid` is globally unique across
categories (`ann_*`/`doc_*`/`rat_*` prefixes observed) and is this fetcher's PK component --
provider-issued, so keyed `(source, uid)` per the composite-key rule even though this endpoint
has only one provider today (`data-sources.md`: never a bare provider id alone). `extra` varies
shape by category (exchange/raw_category for announcements, doc_type/fiscal_year for
documents, agency/instrument_type/outlook for ratings) -- stored as raw JSON text rather than
flattened columns, since no single schema covers all six categories.

`concall_quarters`/`ai_content` (research_report/forensic_analysis/earnings_analysis/
pros_cons AI-content metadata, no body text in this response) are NOT stored here -- out of
scope for a "filings" table; a genuine AI-analysis fetcher would need its own separate design
and its own onboarding pass, not bolted onto this one.

UNIVERSE / AS-OF: nse_stocks ACTIVE by market_cap, --limit (default 200 -- lower than the
other 3 fetchers: this endpoint's payload is much heavier, up to ~44 nested filing items per
symbol). --symbol override.

Run:
  python investsights_announcement_intel_fetcher.py --limit 200
  python investsights_announcement_intel_fetcher.py --symbol WEBELSOLAR
"""

import polars as pl
import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get

BASE = "https://investsights.in/api/v2/market-pulse/stock"
SOURCE = "investsights"
RATE_LIMIT_SEC = 0.3
# Live-measured 2026-08-28 against this host (investsights_fundamentals_fetcher.py's own
# probe): 8 concurrent workers, 16/16 ok, 5.62x speedup, zero errors introduced.
MAX_WORKERS = 8

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def _log(m):
    print(f"[InvestsightsAnnouncementIntel] {m}", flush=True)


def fetch_documents(session: requests.Session, symbol: str) -> dict | None:
    # ponytail: no trailing slash -- live-verified 2026-08-13 this host 404s WITH one and 200s
    # without (`/documents/` vs `/documents`), opposite of most APIs' usual leniency.
    resp = retry_get(session, f"{BASE}/{symbol}/documents", params={"limit": 50}, timeout=20)
    payload = resp.json()
    if not isinstance(payload, dict) or "filings" not in payload:
        return None
    return payload


def parse_rows(symbol: str, payload: dict | None) -> list[dict]:
    if not payload:
        return []
    rows = []
    filings = payload.get("filings") or {}
    for items in filings.values():
        for item in items or []:
            uid = item.get("uid")
            if not uid:
                continue
            rows.append({
                "source": SOURCE, "uid": uid, "symbol": symbol,
                "category": item.get("category"), "origin": item.get("source"),
                "title": item.get("title"), "description": item.get("description"),
                "pdf_link": item.get("pdf_link"),
                "announcement_date": (item.get("announcement_date") or "")[:10] or None,
                "announcement_datetime": item.get("announcement_datetime"),
                "has_ai_analysis": int(bool(item.get("has_ai_analysis"))),
                "has_ai_research": int(bool(item.get("has_ai_research"))),
                "extra_json": json.dumps(item.get("extra") or {}),
            })
    return rows


COLS = ["source", "uid", "symbol", "category", "origin", "title", "description", "pdf_link",
        "announcement_date", "announcement_datetime", "has_ai_analysis", "has_ai_research",
        "extra_json"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS investsights_announcement_intel (
            source TEXT NOT NULL, uid TEXT NOT NULL, symbol TEXT NOT NULL,
            category TEXT, origin TEXT, title TEXT, description TEXT, pdf_link TEXT,
            announcement_date TEXT, announcement_datetime TEXT,
            has_ai_analysis INTEGER, has_ai_research INTEGER, extra_json TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (source, uid)
        )
    """)
    conn.commit()


def store_rows(conn: ConnWrapper, rows: list[dict]) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    update_cols = [c for c in COLS if c not in ("source", "uid")]
    updates = ", ".join(f"{c}=excluded.{c}" for c in update_cols)
    sql = (f"INSERT INTO investsights_announcement_intel ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (source, uid) DO UPDATE SET {updates}")
    for row in rows:
        conn.execute(sql, tuple(row[c] for c in COLS))
    conn.commit()
    return len(rows)


def _load_universe(conn: ConnWrapper, symbol_filter: str | None, limit: int) -> list[str]:
    if symbol_filter:
        return [symbol_filter.upper()]
    rows = conn.execute("""
        SELECT symbol FROM nse_stocks WHERE status = 'ACTIVE' AND market_cap IS NOT NULL
        ORDER BY market_cap DESC LIMIT ?
    """, (limit,)).fetchall()
    return [r["symbol"] if hasattr(r, "keys") else r[0] for r in rows]


def run(symbol_filter: str | None = None, limit: int = 200) -> dict:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    result = {"attempted": 0, "symbols_stored": 0, "rows_stored": 0}
    try:
        ensure_schema(conn)
        universe = _load_universe(conn, symbol_filter, limit)
        _log(f"fetching filings/documents for {len(universe)} symbols...")

        def _fetch_one(symbol):
            try:
                payload = fetch_documents(session, symbol)
                time.sleep(RATE_LIMIT_SEC)
                return symbol, payload, None
            except Exception as e:
                return symbol, None, e

        # Fetch in parallel (network only); parse_rows()/store_rows() stay single-threaded on
        # the main thread as futures resolve -- same pattern as investsights_fundamentals_fetcher.py.
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = [pool.submit(_fetch_one, symbol) for symbol in universe]
            for fut in as_completed(futures):
                symbol, payload, err = fut.result()
                result["attempted"] += 1
                if err is not None:
                    _log(f"{symbol}: failed ({err})")
                    continue
                try:
                    rows = parse_rows(symbol, payload)
                    n = store_rows(conn, rows)
                    if n:
                        result["symbols_stored"] += 1
                        result["rows_stored"] += n
                except Exception as e:
                    _log(f"{symbol}: failed ({e})")
        _log(f"done: {result['symbols_stored']}/{result['attempted']} symbols, "
             f"{result['rows_stored']} filing rows")
    finally:
        conn.close()
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()
    result = run(symbol_filter=args.symbol, limit=args.limit)
    return 0 if result["symbols_stored"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class InvestsightsAnnouncementIntelFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class InvestsightsAnnouncementIntelFetcherBaseFetcher(BaseFetcher[InvestsightsAnnouncementIntelFetcherSchema]):
    fetcher_name = 'InvestsightsAnnouncementIntelFetcher'
    domain = 'investsights.in'
    schema = InvestsightsAnnouncementIntelFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
