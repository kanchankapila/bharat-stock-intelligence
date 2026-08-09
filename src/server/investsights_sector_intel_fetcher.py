#!/usr/bin/env python3
"""
Sector Relative Rotation Graph + sector x sector correlation matrix, from InvestSights.

WHY THIS EXISTS
---------------
This platform's own sector-rotation signal (`relative_strength.py`) is a cross-sectional rank;
`unified_ranker.py`'s `MAX_SECTOR_EXPOSURE` cap (added 2026-07-30) is a first-order position-
sizing guard with NO covariance term -- it caps a sector's aggregate weight but has no idea
whether two differently-named sectors actually move together. The 2026-08-03 urls.txt field
analysis (`docs/url_explorer/DATA_CATEGORIZATION_AND_USAGE.md`) named this exact gap and flagged
InvestSights' sector-correlation endpoint as "the fuller fix that audit note explicitly flagged
as future work," plus a genuine Relative Rotation Graph (Leading/Weakening/Lagging/Improving
quadrants) that has no equivalent anywhere in this codebase.

    https://investsights.in/api/v2/market/sector-rrg?weeks=12
    https://investsights.in/api/v2/market/sector-correlation?period=60

Live-verified 2026-08-06: both endpoints return real, dated, non-empty data with plain
`requests` (no TLS impersonation needed for this host -- see
`investsights_investor_activity_fetcher.py`, `investsights_concall_fetcher.py`).

THIS FETCHER STORES STRUCTURED DATA. IT DOES NOT CHANGE unified_ranker.py's LIVE WEIGHTS.
--------------------------------------------------------------------------------------------
Feeding this correlation matrix into the ranker's actual position-sizing math is a real
algorithm change to a live scoring system and deserves its own dedicated, tested pass -- not a
side effect of adding a data source. This fetcher's job is to stop the data sitting as an
unparsed JSON blob in `extra_endpoint_responses` and make it a real, queryable table; the
ranker-wiring is deliberately left as documented future work (see the urls.txt analysis doc).

ENDPOINT SHAPE -- verified live, do not "fix" these
----------------------------------------------------
* sector-rrg: `data.sectors[].trail[]` is one row per (sector, week) -- NOT a single latest
  snapshot. `weeks=12` returns the full 12-week trail per sector in one call, so no separate
  historical backfill is needed; each daily run just re-upserts the whole trailing window.
* sector-correlation: `matrix` is a plain NxN list-of-lists in the SAME ORDER as the `sectors`
  list (matrix[i][j] = correlation between sectors[i] and sectors[j]). This fetcher only stores
  the upper triangle (i < j) -- storing both halves plus the diagonal (always 1.0) would triple
  the row count for zero new information. `diversifiers`/`redundant` are the API's own tagged
  subset (lowest/highest correlation pairs); a pair not in either list is neither flagged nor
  penalized, it's simply an ordinary pair, and is stored with `pair_type=NULL`.
* `takeaway` is a free-text, third-party-generated summary string. Stored verbatim as
  reference text, never parsed into a numeric feature -- turning prose into a score without a
  defined, testable rule is exactly the kind of guess this codebase's own standing practice
  (CLAUDE.md's "reverse-engineering-first" rule) warns against.

AS-OF DISCIPLINE
-----------------
Both responses carry the provider's own `data_date`/`latest_date` -- used as the primary-key
date column directly, no `date.today()` write-target anchor anywhere in this file (the
midnight-crossing write-target bug class documented in CLAUDE.md only applies to hand-anchored
`WHERE date = ? ELSE NULL` guards; this fetcher only ever INSERTs/upserts rows keyed on a date
the API itself returned).

Run:
  python investsights_sector_intel_fetcher.py
"""
import sys

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get

RRG_API = "https://investsights.in/api/v2/market/sector-rrg"
CORR_API = "https://investsights.in/api/v2/market/sector-correlation"
SOURCE = "investsights"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

VALID_QUADRANTS = {"Leading", "Weakening", "Lagging", "Improving"}


def _log(m):
    print(f"[SectorIntel] {m}", flush=True)


def _num(raw, k):
    try:
        f = float(raw.get(k))
    except (TypeError, ValueError):
        return None
    return None if f != f else f   # NaN -> None; a NaN passes every coverage check


# ── Fetch ────────────────────────────────────────────────────────────────────

def fetch_sector_rrg(session: requests.Session, weeks: int = 12) -> dict:
    """Raw sector-rrg payload. The ONLY fetch path -- tests call this."""
    resp = retry_get(session, RRG_API, params={"weeks": weeks}, timeout=30)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload


def fetch_sector_correlation(session: requests.Session, period: int = 60) -> dict:
    """Raw sector-correlation payload. The ONLY fetch path -- tests call this."""
    resp = retry_get(session, CORR_API, params={"period": period}, timeout=30)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload


# ── Parse ────────────────────────────────────────────────────────────────────

def parse_rrg_rows(payload: dict, weeks: int) -> list:
    """sector-rrg payload -> sector_rrg_history rows."""
    rows = []
    for sec in (payload.get("sectors") or []):
        sector = (sec.get("sector") or "").strip()
        if not sector:
            continue
        for pt in (sec.get("trail") or []):
            week_date = (pt.get("week_date") or "")[:10]
            if not week_date:
                continue
            quadrant = (pt.get("quadrant") or "").strip() or None
            if quadrant is not None and quadrant not in VALID_QUADRANTS:
                quadrant = None   # unrecognized label -- store as unknown rather than guess
            rows.append({
                "sector": sector, "week_date": week_date,
                "rs_ratio": _num(pt, "rs_ratio"), "rs_momentum": _num(pt, "rs_momentum"),
                "sector_return": _num(pt, "sector_return"),
                "stocks_count": int(_num(pt, "stocks_count")) if _num(pt, "stocks_count") is not None else None,
                "quadrant": quadrant, "weeks_window": weeks, "source": SOURCE,
            })
    return rows


def parse_correlation_pairs(payload: dict) -> list:
    """sector-correlation payload -> sector_correlation_pairs rows (upper triangle only)."""
    data_date = (payload.get("data_date") or "")[:10]
    sectors = payload.get("sectors") or []
    matrix = payload.get("matrix") or []
    if not data_date or not sectors or len(matrix) != len(sectors):
        return []
    period_days = payload.get("period_days")

    tagged = {}   # frozenset({a, b}) -> pair_type
    for item in (payload.get("diversifiers") or []):
        a, b = item.get("sector_a"), item.get("sector_b")
        if a and b:
            tagged[frozenset((a, b))] = "diversifier"
    for item in (payload.get("redundant") or []):
        a, b = item.get("sector_a"), item.get("sector_b")
        if a and b:
            tagged[frozenset((a, b))] = "redundant"

    rows = []
    n = len(sectors)
    for i in range(n):
        row_i = matrix[i] if isinstance(matrix[i], list) else []
        for j in range(i + 1, n):
            if j >= len(row_i):
                continue
            try:
                corr = float(row_i[j])
            except (TypeError, ValueError):
                continue
            if corr != corr:   # NaN
                continue
            a, b = sectors[i], sectors[j]
            rows.append({
                "data_date": data_date, "sector_a": a, "sector_b": b,
                "correlation": corr, "period_days": period_days,
                "pair_type": tagged.get(frozenset((a, b))), "source": SOURCE,
            })
    return rows


def parse_stats_rows(payload: dict) -> list:
    """sector-correlation payload -> sector_correlation_stats rows."""
    data_date = (payload.get("data_date") or "")[:10]
    if not data_date:
        return []
    period_days = payload.get("period_days")
    rows = []
    for s in (payload.get("sector_stats") or []):
        name = (s.get("name") or "").strip()
        if not name:
            continue
        rows.append({
            "data_date": data_date, "sector": name,
            "avg_daily_return": _num(s, "avg_daily_return"), "volatility": _num(s, "volatility"),
            "total_return": _num(s, "total_return"),
            "data_points": int(_num(s, "data_points")) if _num(s, "data_points") is not None else None,
            "period_days": period_days, "source": SOURCE,
        })
    return rows


def parse_summary_row(payload: dict) -> dict | None:
    """sector-correlation payload -> one sector_correlation_summary row."""
    data_date = (payload.get("data_date") or "")[:10]
    if not data_date:
        return None
    breadth = payload.get("breadth") or {}
    takeaway = payload.get("takeaway")
    return {
        "data_date": data_date,
        "avg_pairwise_correlation": _num(breadth, "avg_pairwise_correlation"),
        "pct_pairs_above_0_7": _num(breadth, "pct_pairs_above_0_7"),
        "total_pairs": int(_num(breadth, "total_pairs")) if _num(breadth, "total_pairs") is not None else None,
        "takeaway": (str(takeaway).strip() if takeaway else None),
        "source": SOURCE,
    }


# ── Schema + store ──────────────────────────────────────────────────────────

RRG_COLS = ["sector", "week_date", "rs_ratio", "rs_momentum", "sector_return",
            "stocks_count", "quadrant", "weeks_window", "source"]
PAIR_COLS = ["data_date", "sector_a", "sector_b", "correlation", "period_days",
             "pair_type", "source"]
STATS_COLS = ["data_date", "sector", "avg_daily_return", "volatility", "total_return",
              "data_points", "period_days", "source"]
SUMMARY_COLS = ["data_date", "avg_pairwise_correlation", "pct_pairs_above_0_7",
                "total_pairs", "takeaway", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sector_rrg_history (
            sector TEXT NOT NULL, week_date TEXT NOT NULL,
            rs_ratio REAL, rs_momentum REAL, sector_return REAL,
            stocks_count INTEGER, quadrant TEXT, weeks_window INTEGER,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (sector, week_date)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sector_correlation_pairs (
            data_date TEXT NOT NULL, sector_a TEXT NOT NULL, sector_b TEXT NOT NULL,
            correlation REAL, period_days INTEGER, pair_type TEXT,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (data_date, sector_a, sector_b)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sector_correlation_stats (
            data_date TEXT NOT NULL, sector TEXT NOT NULL,
            avg_daily_return REAL, volatility REAL, total_return REAL,
            data_points INTEGER, period_days INTEGER,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (data_date, sector)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sector_correlation_summary (
            data_date TEXT PRIMARY KEY,
            avg_pairwise_correlation REAL, pct_pairs_above_0_7 REAL, total_pairs INTEGER,
            takeaway TEXT, source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def _upsert(conn: ConnWrapper, table: str, cols: list, key_cols: list, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(cols))
    update_cols = [c for c in cols if c not in key_cols]
    updates = ", ".join(f"{c}=excluded.{c}" for c in update_cols)
    conflict = ", ".join(key_cols)
    sql = (f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({ph}) "
           f"ON CONFLICT ({conflict}) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in cols))
        n += 1
    conn.commit()
    return n


def store_rrg(conn: ConnWrapper, rows: list) -> int:
    return _upsert(conn, "sector_rrg_history", RRG_COLS, ["sector", "week_date"], rows)


def store_pairs(conn: ConnWrapper, rows: list) -> int:
    return _upsert(conn, "sector_correlation_pairs", PAIR_COLS,
                    ["data_date", "sector_a", "sector_b"], rows)


def store_stats(conn: ConnWrapper, rows: list) -> int:
    return _upsert(conn, "sector_correlation_stats", STATS_COLS, ["data_date", "sector"], rows)


def store_summary(conn: ConnWrapper, row: dict | None) -> int:
    return _upsert(conn, "sector_correlation_summary", SUMMARY_COLS, ["data_date"],
                    [row] if row else [])


def run(weeks: int = 12, period: int = 60) -> dict:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    result = {"rrg_rows": 0, "pair_rows": 0, "stats_rows": 0, "summary_rows": 0}
    try:
        ensure_schema(conn)

        try:
            rrg_payload = fetch_sector_rrg(session, weeks=weeks)
            rrg_rows = parse_rrg_rows(rrg_payload, weeks)
            result["rrg_rows"] = store_rrg(conn, rrg_rows)
            _log(f"sector-rrg: {result['rrg_rows']} (sector, week) rows stored")
        except Exception as e:
            _log(f"sector-rrg fetch/parse failed: {e}")

        try:
            corr_payload = fetch_sector_correlation(session, period=period)
            pair_rows = parse_correlation_pairs(corr_payload)
            stats_rows = parse_stats_rows(corr_payload)
            summary_row = parse_summary_row(corr_payload)
            result["pair_rows"] = store_pairs(conn, pair_rows)
            result["stats_rows"] = store_stats(conn, stats_rows)
            result["summary_rows"] = store_summary(conn, summary_row)
            _log(f"sector-correlation: {result['pair_rows']} pairs, "
                 f"{result['stats_rows']} sector-stats, {result['summary_rows']} summary rows stored")
        except Exception as e:
            _log(f"sector-correlation fetch/parse failed: {e}")
    finally:
        conn.close()
    return result


def main() -> int:
    result = run()
    if not any(result.values()):
        _log("both endpoints failed -- nothing stored")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())