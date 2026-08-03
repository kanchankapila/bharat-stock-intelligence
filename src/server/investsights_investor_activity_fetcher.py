#!/usr/bin/env python3
"""
Superstar-investor conviction tracking, from InvestSights.

WHY THIS EXISTS
---------------
This platform's existing FII/DII/MF ownership features (`ext_fii_holding_pct`, `mf_holding_pct`,
etc.) are all AGGREGATE holding percentages -- they say how much of a stock's float is
institutionally held, never WHO holds it or whether a specific, named, historically-successful
investor is currently building or exiting a position. The 2026-08-03 urls.txt field analysis
(`docs/url_explorer/DATA_CATEGORIZATION_AND_USAGE.md`) flagged this as the top new-data
opportunity: it closes a gap this codebase's own 2026-07-31 endpoint-corpus review had already
named ("superstar investor conviction tracking") and left unbuilt.

    https://investsights.in/api/v2/investors/?only_superstars=true&sort_by=total_stocks_held&limit=N
    https://investsights.in/api/v2/investors/{slug}/activity?limit=N

Live-verified 2026-08-03: the investor list returns real superstar profiles (e.g. LIC, Government
Pension Fund Global, 60 investors at limit=60) with aggregate stats (`total_stocks_held`,
`new_entries_count`, `exits_count`, `increased_count`, `decreased_count`); the per-investor
`/activity` endpoint returns `recent_changes` -- individual, dated, per-symbol portfolio changes
(`change_type` in entry/exit/increase/decrease, `curr_pct_holding`, `pct_holding_change`) -- this
is the piece that turns "investor tracking" into an actual per-stock signal rather than just an
archived investor directory.

ENDPOINT QUIRKS -- verified live, do not "fix" these
-----------------------------------------------------
* The `symbol` field on both `current_holdings` (from `/investors/{slug}`) and `recent_changes`
  (from `/investors/{slug}/activity`) is NOT always an NSE ticker -- some rows carry a raw BSE
  numeric scrip code instead (live-confirmed: "517238" for Dynavision Ltd, alongside a normal
  ticker "APOLSINHOT" in the same investor's holdings). No BSE-code resolver exists in this
  codebase for this provider, and inventing one here would repeat the exact URL/ID-as-symbol
  mistake this project has already been burned by twice (the 2026-07-23 Trendlyne URL-as-symbol
  corruption, the raw-numeric-symbol artifact still sitting in `nse_stocks`/`stocklist.ts`). This
  fetcher only keeps rows whose `symbol` matches an existing ticker in `nse_stocks`
  (case-insensitive exact match) -- BSE-only-listed holdings are silently DROPPED, not corrupted.
  This is an accepted coverage tradeoff, not a bug: check `nse_stocks` coverage before assuming a
  stock is simply "not superstar-held" if it happens to be BSE-only-listed.
* Only `only_superstars=true` is fetched. The wider non-superstar investor universe exists on
  this same API but is lower-conviction signal and out of scope for this fetcher.
* Each investor's `/activity` call is a SEPARATE request (no bulk "all changes" endpoint found
  in urls.txt's capture) -- this fetcher is O(superstar_count) requests, not O(1). Kept
  sequential (~60 requests at the default limit) rather than threaded, matching this codebase's
  general preference for simple, easily-debuggable I/O over `extra_endpoints_fetcher.py`-style
  thread pools for fetchers with a small, bounded request count.

AS-OF DISCIPLINE
-----------------
`curr_period_date` is InvestSights' own disclosure-processing date, already historical by the
time it's fetched (shareholding filings lag the actual holding date by weeks, same class of
delay documented in `earnings_beat_features.py`'s `PERIOD_LAG_DAYS`). This fetcher does not
attempt its own publication-lag correction -- it stores the row's own `period_end_date` as-is
and leaves as-of joining to the consumer, same as `tickertape_deals_fetcher.py`'s stated
approach for `as_of.py` to handle downstream.

Run:
  python investsights_investor_activity_fetcher.py --limit 60
"""
import argparse
import sys

import requests

from db_compat import connect, ConnWrapper, query_all
from fetch_utils import retry_get

INVESTORS_API = "https://investsights.in/api/v2/investors/"
ACTIVITY_API = "https://investsights.in/api/v2/investors/{slug}/activity"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

VALID_CHANGE_TYPES = {"entry", "exit", "increase", "decrease"}


def _log(m):
    print(f"[SuperstarActivity] {m}", flush=True)


def fetch_superstar_investors(session: requests.Session, limit: int = 60) -> list:
    """List of superstar-labeled investors. The ONLY fetch path -- tests call this."""
    resp = retry_get(session, INVESTORS_API,
                      params={"only_superstars": "true", "sort_by": "total_stocks_held",
                              "page": 0, "limit": limit},
                      timeout=30)
    payload = resp.json()
    if not isinstance(payload, dict):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload.get("investors") or []


def fetch_investor_activity(session: requests.Session, slug: str, limit: int = 100) -> list:
    """One investor's recent portfolio changes. The ONLY fetch path -- tests call this."""
    resp = retry_get(session, ACTIVITY_API.format(slug=slug), params={"limit": limit}, timeout=30)
    payload = resp.json()
    if not isinstance(payload, dict):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload.get("recent_changes") or []


def parse_change(slug: str, investor_name: str | None, raw: dict, universe: set) -> dict | None:
    """One activity row -> one superstar_investor_activity row, or None if not usable."""
    symbol = (raw.get("symbol") or "").strip().upper()
    if not symbol or symbol not in universe:
        return None
    change_type = (raw.get("change_type") or "").strip().lower()
    if change_type not in VALID_CHANGE_TYPES:
        return None
    period = (raw.get("curr_period_date") or "")[:10]
    if not period:
        return None
    change_id = raw.get("id")
    if change_id is None:
        return None

    def num(k):
        try:
            f = float(raw.get(k))
        except (TypeError, ValueError):
            return None
        return None if f != f else f   # NaN -> None; a NaN passes every coverage check

    return {
        # Namespaced so it can never collide with a differently-sourced id in this table.
        "id": f"is:{change_id}",
        "investor_slug": slug,
        "investor_name": (investor_name or "").strip() or None,
        "symbol": symbol,
        "change_type": change_type,
        "curr_pct_holding": num("curr_pct_holding"),
        "pct_holding_change": num("pct_holding_change"),
        "period_end_date": period,
        "source": "investsights",
    }


COLS = ["id", "investor_slug", "investor_name", "symbol", "change_type",
        "curr_pct_holding", "pct_holding_change", "period_end_date", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS superstar_investor_activity (
            id TEXT PRIMARY KEY, investor_slug TEXT NOT NULL, investor_name TEXT,
            symbol TEXT NOT NULL, change_type TEXT NOT NULL,
            curr_pct_holding REAL, pct_holding_change REAL, period_end_date TEXT,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO superstar_investor_activity ({', '.join(COLS)}) VALUES ({ph}) "
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


def run(limit: int = 60, activity_limit: int = 100) -> int:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    try:
        ensure_schema(conn)
        universe = load_nse_universe()
        investors = fetch_superstar_investors(session, limit=limit)
        _log(f"{len(investors)} superstar investors found")
        total_seen = total_stored = skipped = failed_investors = 0
        for inv in investors:
            slug = inv.get("slug")
            if not slug:
                continue
            try:
                changes = fetch_investor_activity(session, slug, limit=activity_limit)
            except Exception as e:
                failed_investors += 1
                _log(f"  {slug}: fetch failed ({e}), skipping")
                continue
            total_seen += len(changes)
            rows = [r for r in (parse_change(slug, inv.get("canonical_name"), c, universe)
                                 for c in changes) if r is not None]
            skipped += len(changes) - len(rows)
            total_stored += store(conn, rows)
        _log(f"fetched {total_seen} changes across {len(investors)} investors "
             f"({failed_investors} investor fetches failed), stored {total_stored}, "
             f"skipped {skipped} (non-NSE symbol or unusable)")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    # A run that found zero superstar investors at all is a real failure (endpoint shape
    # changed, auth wall, etc.) -- distinct from a run that found investors but stored zero
    # new changes because everything was already up to date.
    return 0 if investors else 1


def main():
    ap = argparse.ArgumentParser(description="InvestSights superstar-investor conviction tracking")
    ap.add_argument("--limit", type=int, default=60, help="max superstar investors to fetch")
    ap.add_argument("--activity-limit", type=int, default=100,
                    help="max recent changes per investor")
    args = ap.parse_args()
    sys.exit(run(limit=args.limit, activity_limit=args.activity_limit))


if __name__ == "__main__":
    main()
