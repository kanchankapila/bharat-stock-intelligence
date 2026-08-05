#!/usr/bin/env python3
"""
Pre-flight coverage gate for wiring a NEW engine into unified_ranker.py's REGIME_WEIGHTS blend.

WHY THIS EXISTS
---------------
technical_signals is the feature matrix every engine ultimately draws from, directly or
indirectly (screener/ml/cs/confluence/technical/dl/breakout/smart_money all touch it somewhere).
Two documented traps make "does my new engine's input column have data" surprisingly easy to
get wrong:

1. Measuring coverage on a PARTIAL day looks catastrophic even for a healthy column. The
   2026-07-30 bias audit's own first pass measured 2026-07-31 (a day with only 21 of ~2,188
   rows built yet) and got 248 "0% coverage" columns; re-measuring on a complete date (2,188
   rows) found only 11 genuinely at 0%. This tool always resolves a full-row-count date first
   -- never `date.today()` -- so you can't repeat that mistake.

2. Measuring coverage BEFORE forward-fill looks catastrophic even for a column with a real,
   just-infrequent, writer. A quarterly-cadence fundamental (e.g. `roce`) is 0% on 364 days of
   the year by construction and ~74% once `densify_feature_matrix.py` has forward-filled it --
   checking the raw column instead of the densified one is the single most common way to
   wrongly conclude "this feature has no data" and either skip a genuinely useful engine input
   or, worse, wire an engine to a column that really IS empty (e.g. `mc_cagr_3y`, which densify
   correctly can NOT fill because it has never had a non-null value in the retained window at
   all -- a fetcher-cadence gap, not a join-window gap, and coverage-checking is what tells
   the two apart).

USAGE
-----
Before adding a 9th (or Nth) key to unified_ranker.py's REGIME_WEIGHTS, run:

    python feature_coverage_gate.py --columns roce,mf_flow_rank,insider_buy_pct_90d

or import assert_columns_ready() directly from a training/backfill script. A column below
MIN_COVERAGE_DEFAULT is not necessarily unusable -- but it means you are about to build an
engine whose input is NULL for most of the universe most of the time, and that decision should
be made deliberately, with the real number in front of you, not discovered after the engine
ships and someone re-derives it under audit pressure (which is how this tool came to exist).

This intentionally does not touch REGIME_WEIGHTS itself -- see
test_engine_coverage_gate.py::test_regime_weights_engine_count_is_pinned for the enforcement
half (a pinned count that forces whoever adds a 9th engine to consciously update the test,
which is the point at which they should have already run this tool).
"""
import argparse
import sys

from db_compat import connect

# Below this fraction non-null on a full-row-count, post-densification date, a proposed
# engine input is "mostly NULL" -- not disqualifying by itself, but must be a conscious choice.
MIN_COVERAGE_DEFAULT = 0.05

# How many recent calendar days to scan for the busiest (most complete) row-count date. 14
# comfortably spans any single-week outage/holiday cluster without reaching back into a
# different data regime.
LOOKBACK_DAYS_DEFAULT = 14


def full_row_count_date(conn, lookback_days: int = LOOKBACK_DAYS_DEFAULT) -> str | None:
    """Return the date within the last `lookback_days` with the most technical_signals rows
    -- the "full-row-count date" the densify/coverage-audit sessions established as the only
    safe day to measure coverage against. Returns None if the table is empty."""
    rows = conn.execute(
        """
        SELECT date::text, COUNT(*) AS n
        FROM technical_signals
        WHERE date::text >= (CURRENT_DATE - %s)::text
        GROUP BY date::text
        ORDER BY n DESC, date::text DESC
        LIMIT 1
        """ % int(lookback_days)
    ).fetchall()
    if not rows:
        return None
    return rows[0][0]


def column_coverage(conn, columns: list[str], probe_date: str) -> dict[str, dict]:
    """Per-column non-null coverage on `probe_date`. Returns
    {column: {"non_null": int, "total": int, "coverage": float}}.
    Missing/misspelled columns are reported with coverage=None rather than raising, so a typo
    surfaces as an obvious result instead of a stack trace mid-CLI-run."""
    total = conn.execute(
        "SELECT COUNT(*) FROM technical_signals WHERE date::text = ?", (probe_date,)
    ).fetchone()[0]

    out: dict[str, dict] = {}
    for col in columns:
        try:
            n = conn.execute(
                f'SELECT COUNT("{col}") FROM technical_signals WHERE date::text = ?',
                (probe_date,),
            ).fetchone()[0]
        except Exception as e:
            out[col] = {"non_null": None, "total": total, "coverage": None, "error": str(e)}
            continue
        out[col] = {
            "non_null": n,
            "total": total,
            "coverage": (n / total) if total else 0.0,
        }
    return out


def assert_columns_ready(conn, columns: list[str], min_coverage: float = MIN_COVERAGE_DEFAULT,
                          probe_date: str | None = None) -> dict[str, dict]:
    """Raise AssertionError naming every column below `min_coverage`. Returns the full
    coverage report on success so a caller can log it, not just trust a boolean pass."""
    date = probe_date or full_row_count_date(conn)
    if date is None:
        raise AssertionError("technical_signals has no rows in the lookback window -- cannot measure coverage")

    report = column_coverage(conn, columns, date)
    failures = []
    for col, r in report.items():
        if r["coverage"] is None:
            failures.append(f"  {col}: ERROR ({r.get('error')}) -- does this column exist?")
        elif r["coverage"] < min_coverage:
            failures.append(
                f"  {col}: {r['coverage']:.1%} non-null ({r['non_null']}/{r['total']}) "
                f"on {date} -- below the {min_coverage:.0%} floor"
            )
    if failures:
        raise AssertionError(
            f"feature_coverage_gate: {len(failures)}/{len(columns)} column(s) fail the "
            f"{min_coverage:.0%} coverage floor on {date} (post-densification, full-row-count "
            "date). Before wiring these into a new unified_ranker engine, confirm this is "
            "expected (e.g. a genuinely fetcher-cadence-limited column like mc_cagr_3y) rather "
            "than a join-window/naming bug:\n" + "\n".join(failures)
        )
    return report


def _cli():
    parser = argparse.ArgumentParser(description=__doc__.split("USAGE")[0])
    parser.add_argument("--columns", required=True, help="comma-separated technical_signals column names")
    parser.add_argument("--min-coverage", type=float, default=MIN_COVERAGE_DEFAULT)
    parser.add_argument("--date", default=None, help="probe a specific date instead of auto-resolving the busiest recent one")
    args = parser.parse_args()

    columns = [c.strip() for c in args.columns.split(",") if c.strip()]
    conn = connect()
    try:
        date = args.date or full_row_count_date(conn)
        if date is None:
            print("No technical_signals rows found in the lookback window.", file=sys.stderr)
            sys.exit(1)
        report = column_coverage(conn, columns, date)
        print(f"Coverage report for {date} ({'auto-resolved full-row-count date' if not args.date else 'explicit date'}):")
        any_below = False
        for col, r in report.items():
            if r["coverage"] is None:
                print(f"  {col:35s} ERROR: {r.get('error')}")
                any_below = True
                continue
            marker = "OK " if r["coverage"] >= args.min_coverage else "LOW"
            if marker == "LOW":
                any_below = True
            print(f"  {col:35s} {marker}  {r['coverage']:6.1%}  ({r['non_null']}/{r['total']})")
        sys.exit(1 if any_below else 0)
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    _cli()
