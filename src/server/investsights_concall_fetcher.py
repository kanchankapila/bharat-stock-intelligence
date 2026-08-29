#!/usr/bin/env python3
"""
AI-generated earnings-call tone/takeaway, from InvestSights.

WHY THIS EXISTS
---------------
CLAUDE.md's own quant-strategy audit (2026-07-30/31, `docs/audit-2026-07-30/
DATA_BIAS_AND_QUANT_STRATEGY_AUDIT.md`) concluded the one place an LLM layer earns its keep on
this platform is unstructured text with no parser equivalent -- concall transcripts -- and that
its output must land as a bounded, timestamped component score, never a free-floating verdict.
The 2026-08-03 urls.txt field analysis found InvestSights has already built exactly this
(third-party, not an in-house pipeline this platform would otherwise have to build):

    https://investsights.in/api/v2/concall/recent?limit=N

Live-verified 2026-08-06: real, current items (`announcement_date` within the last day at fetch
time), well-timestamped (`announcement_date` = when the company disclosed the concall to the
exchange, `generated_at` = when InvestSights' own AI produced the summary).

THIS FETCHER STORES STRUCTURED TEXT. IT DOES NOT SCORE THE TEXT.
--------------------------------------------------------------------
`key_takeaway` and `tone_assessment` are stored verbatim as reference text. This deliberately
does NOT attempt to turn `tone_assessment`'s prose into a numeric sentiment score -- picking
keywords ("confident" -> +1, "cautious" -> -1) out of AI-generated free text is a guess with no
defined, testable rule behind it, exactly what this codebase's "reverse-engineering-first"
standing practice warns against. A real numeric feature from this table is a follow-up that
needs its own validation (does a naive keyword score actually correlate with forward returns,
the same question `factor_edge.py` already asks of other scores) -- not assumed here.

ENDPOINT SHAPE -- verified live, do not "fix" these
----------------------------------------------------
* No `id`/`_id` field on an item. The natural key is (symbol, fiscal_year, quarter) -- one
  concall per company per quarter. `id` here is a deterministic composite, not a raw upstream id.
* `limit=N` returns the N most-recently-generated items across ALL companies (not per-symbol),
  sorted by recency -- there is no pagination param found in urls.txt's capture, so this fetcher
  simply re-fetches the recent window on every run; a company's concall dropping off the window
  before it's been fetched once is an accepted gap (same class of coverage tradeoff already
  documented in `investsights_investor_activity_fetcher.py`), not a bug to chase.

AS-OF DISCIPLINE
-----------------
`announcement_date` is the real disclosure timestamp and is what any consumer should join
as-of; `generated_at` (when the AI summary was produced, always later) is kept only as
provenance, never as the join key -- joining on `generated_at` would let a same-day-of-signal
company's concall leak into a feature before the market actually knew about it, if InvestSights
ever re-generates a summary for an older concall.

Run:
  python investsights_concall_fetcher.py
"""

import polars as pl
import sys

import requests

from db_compat import connect, ConnWrapper, query_all
from fetch_utils import retry_get

API = "https://investsights.in/api/v2/concall/recent"
SOURCE = "investsights"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def _log(m):
    print(f"[Concall] {m}", flush=True)


def fetch_recent(session: requests.Session, limit: int = 20) -> list:
    """Recent concall summaries. The ONLY fetch path -- tests call this."""
    resp = retry_get(session, API, params={"limit": limit}, timeout=30)
    payload = resp.json()
    if not isinstance(payload, dict):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload.get("items") or []


def parse_item(raw: dict, universe: set) -> dict | None:
    """One API item -> one concall_takeaways row, or None if not usable."""
    symbol = (raw.get("symbol") or "").strip().upper()
    if not symbol or symbol not in universe:
        return None
    quarter = (raw.get("quarter") or "").strip()
    fiscal_year = (raw.get("fiscal_year") or "").strip()
    if not quarter or not fiscal_year:
        return None
    announcement_date = (raw.get("announcement_date") or "")[:10]
    if not announcement_date:
        return None

    return {
        # Deterministic -- the upstream payload has no id of its own (see module docstring).
        "id": f"is:{symbol}:{fiscal_year}:{quarter}",
        "symbol": symbol,
        "company_name": (raw.get("company_name") or "").strip() or None,
        "quarter": quarter,
        "fiscal_year": fiscal_year,
        "key_takeaway": (raw.get("key_takeaway") or "").strip() or None,
        "tone_assessment": (raw.get("tone_assessment") or "").strip() or None,
        "transcript_source": (raw.get("transcript_source") or "").strip() or None,
        "announcement_date": announcement_date,
        "generated_at": (raw.get("generated_at") or "").strip() or None,
        "source": SOURCE,
    }


COLS = ["id", "symbol", "company_name", "quarter", "fiscal_year", "key_takeaway",
        "tone_assessment", "transcript_source", "announcement_date", "generated_at", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS concall_takeaways (
            id TEXT PRIMARY KEY, symbol TEXT NOT NULL, company_name TEXT,
            quarter TEXT NOT NULL, fiscal_year TEXT NOT NULL,
            key_takeaway TEXT, tone_assessment TEXT, transcript_source TEXT,
            announcement_date TEXT NOT NULL, generated_at TEXT,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO concall_takeaways ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (id) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def load_nse_universe() -> set:
    rows = query_all("SELECT symbol FROM nse_stocks")
    return {(r["symbol"] or "").upper() for r in rows if r.get("symbol")}


def run(limit: int = 20) -> int:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    try:
        ensure_schema(conn)
        universe = load_nse_universe()
        raw_items = fetch_recent(session, limit=limit)
        rows = [r for r in (parse_item(i, universe) for i in raw_items) if r is not None]
        n = store(conn, rows)
        _log(f"{len(raw_items)} seen, {n} stored ({len(raw_items) - len(rows)} skipped: "
             f"unresolvable symbol or missing quarter/date)")
        return n
    finally:
        conn.close()


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

class InvestsightsConcallFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class InvestsightsConcallFetcherBaseFetcher(BaseFetcher[InvestsightsConcallFetcherSchema]):
    fetcher_name = 'InvestsightsConcallFetcher'
    domain = 'investsights.in'
    schema = InvestsightsConcallFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
