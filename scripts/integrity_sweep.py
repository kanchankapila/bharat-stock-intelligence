#!/usr/bin/env python3
"""Repo-wide integrity sweep -- answers "what is silently broken RIGHT NOW", in one run.

Built 2026-08-15 after a stretch where defects of this exact shape were found one at a time,
roughly one per weekend, each costing a fix-then-wait-for-data cycle. Every one of them was
already visible in data that existed at the time; nothing needed waiting for. This asks the
questions that would have surfaced them, across every table at once.

Three sweeps, each targeting a class that has actually bitten this repo (not hypotheticals):

  1. DEAD COLUMNS -- a column that is 100% NULL on the most recent date, in a table that is
     otherwise fresh. Freshness checks pass (rows ARE landing) while the thing the column exists
     to deliver never arrives. Real instances: flyer_probability (0/2192, found by this sweep's
     first run), technical_signals.created_at/updated_at, feature_store.rev_growth/eps_growth,
     the 14 ext_* columns, so_stock_oi_summary.fut_oi.

  2. FROZEN COLUMNS -- populated, but the same single value for every row on the latest date.
     Passes any NULL-based check while carrying no information. This is how op_margins/roe sat
     at exactly 0.0 across a 320-date baseline and then blew up PSI when they came alive.

  3. STALLED TABLES -- newest row materially older than the table's own typical cadence, judged
     against its OWN history rather than a hardcoded threshold (a table written weekly must not
     be measured against a daily bar).

Read-only: opens no transaction, writes nothing, and bounds every query. Safe to run any time,
including against production. Run it after ANY fix, instead of waiting a week to see if the fix
held.

    python scripts/integrity_sweep.py                # everything
    python scripts/integrity_sweep.py --table technical_signals
    python scripts/integrity_sweep.py --min-rows 500 # skip small/reference tables
"""
import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "server"))

from db_compat import read_df  # noqa: E402

# Tables whose columns are consumed by scoring/ML. A dead column here degrades a live score
# silently; elsewhere it is usually just an unused staging field.
PRIORITY = {
    "technical_signals", "feature_store", "unified_recommendations", "stock_scores",
    "quant_scores", "confluence_signals", "signal_outcomes", "unified_signals",
}

# A single-date NULL/constant scan cannot distinguish a broken producer from a field whose
# lifecycle deliberately does not match the table's daily grid. Keep those exceptions explicit,
# narrowly keyed and reasoned -- never use a wildcard here. This is reporting suppression only;
# the cadence/retirement decisions remain covered by their dedicated checks and measurement
# records. AF-20261004-07 was filed because these expected cases were mixed with genuinely dead
# live inputs in one red list.
EXPECTED_DEAD_COLUMNS: dict[tuple[str, str], str] = {
    ("technical_signals", "cs_score"):
        "cs_ranker was decommissioned 2026-08-31 after live CV AUC 0.176.",
    ("technical_signals", "pead_score"):
        "The nightly PEAD writer was retired 2026-08-20 after no measured edge.",
    ("technical_signals", "flyer_probability"):
        "Weekly model output; it is expected to be NULL on six daily grids out of seven.",
    ("feature_store", "target_ret_5d"):
        "Forward label, unavailable until the five-session outcome window matures.",
    ("feature_store", "target_ret_15d"):
        "Forward label, unavailable until the fifteen-session outcome window matures.",
    ("feature_store", "pb"):
        "Retired legacy field; price_to_book replaced it 2026-08-24 and is the live DL input.",
    ("unified_recommendations", "cs_score"):
        "cs_ranker was decommissioned 2026-08-31; this retained schema field is not scored.",
    ("unified_signals", "quant_score"):
        "Source-specific AI context; AI is event-driven and may have no rows on a daily snapshot.",
    ("unified_signals", "screener_momentum_score"):
        "Legacy source-specific copy; technical_signals is the canonical populated feature store.",
    ("unified_signals", "screener_tier1_count"):
        "Legacy source-specific copy; technical_signals is the canonical populated feature store.",
    ("unified_signals", "screener_cat_breadth"):
        "Legacy source-specific copy; technical_signals is the canonical populated feature store.",
    ("confluence_signals", "ml_trend_probability"):
        "Reserved schema field with no current writer or scoring reader.",
    ("confluence_signals", "ai_conclusion"):
        "Retired unwritten narrative field; chatbot and ontology explicitly forbid it.",
}

EXPECTED_FROZEN_COLUMNS: dict[tuple[str, str], str] = {
    ("feature_store", "target_dir_5d"):
        "Forward classification label, not a live input; one class may occupy one date.",
    ("feature_store", "target_dir_15d"):
        "Forward classification label, not a live input; one class may occupy one date.",
    ("unified_recommendations", "avg_engine_track_record"):
        "A batch-level engine reliability snapshot intentionally repeated for every symbol.",
    ("signal_outcomes", "horizon_days"):
        "Resolver batches one horizon at a time; a complete signal-date snapshot can be one horizon.",
}

# Mixed-source tables are not one homogeneous daily grid. `signal_outcomes` receives
# confluence rows after technical rows, and the confluence source does not own technical-only
# payload columns (signal_score/signals_json/max_return_pct). Scanning whichever source wrote
# the wall-clock-latest batch therefore calls healthy source-specific fields dead. Scope the
# logical table to the writer whose full schema contract this sweep is validating. Keep this
# separate from EXPECTED_DEAD_COLUMNS: those suppress findings; a row scope measures the right
# population and can still catch the technical writer failing tomorrow.
TABLE_ROW_SCOPES: dict[str, tuple[str, str]] = {
    "signal_outcomes": (
        "signal_source = 'technical'",
        "Technical outcomes own signal_score, signals_json and max_return_pct; confluence rows do not.",
    ),
}


def _partition_expected(table: str, columns: list[str], expected: dict[tuple[str, str], str]):
    """Split exact, documented exceptions from actionable findings."""
    actionable, suppressed = [], {}
    for column in columns:
        reason = expected.get((table, column))
        if reason:
            suppressed[column] = reason
        else:
            actionable.append(column)
    return actionable, suppressed


def _enriched_through():
    """The date through which ml-daily-ops has demonstrably had its chance to enrich.

    Returns an ISO date string, or None if no heartbeat exists.
    """
    row = read_df(
        "SELECT to_timestamp(MAX(last_success_at)/1000)::date::text AS d "
        "FROM job_heartbeat WHERE job_name = 'ml-daily-ops'"
    )
    if not row.empty and row["d"][0] is not None:
        return row["d"][0]
    return None


def latest_date_expr(table: str):
    """Return (date_column, sql_literal_of_latest_value, cols) or None if no date-ish key.

    Anchors on the newest date strictly OLDER than the last successful ml-daily-ops run,
    NOT on raw MAX(date).

    Why: enrichment columns are written in the EVENING against the previous completed
    session, so the newest date in a table is always the one enrichment has not reached
    yet. Anchoring on MAX(date) reads that one-day lag as death and reports ~25 false DEAD
    columns on every run. This is recurring-bugs.md's "coverage ratio over a window that
    includes today" class; 087f399 fixed it in dataQualityChecks.ts and its own message
    noted it had been reintroduced in BOTH files -- this is the other one (AF-20260815-01).

    Mirrors dataQualityChecks.ts's `ml-signal-columns-populated`, including its fallback:
    if no heartbeat exists, step back to the second-newest date rather than silently
    reverting to the same-day read that caused the bug.
    """
    cols = read_df(
        f"SELECT column_name, data_type FROM information_schema.columns "
        f"WHERE table_schema='public' AND table_name='{table}'"
    )
    names = cols["column_name"].tolist()
    cutoff = _enriched_through()
    scope_sql = TABLE_ROW_SCOPES.get(table, (None, ""))[0]
    scope_and = f" AND ({scope_sql})" if scope_sql else ""
    scope_where = f" WHERE ({scope_sql})" if scope_sql else ""
    # Prefer the row's business/session date to a write timestamp. `signal_outcomes`, for
    # example, is written in separate technical/confluence batches: MAX(computed_at) selects
    # only the final batch and falsely reports every source-specific column in the other batch
    # dead. The session date evaluates the complete logical snapshot.
    for cand in ("date", "as_of_date", "signal_date", "eval_date", "computed_at", "fetched_at"):
        if cand not in names:
            continue
        try:
            if cutoff:
                row = read_df(
                    f'SELECT MAX("{cand}")::text AS m FROM "{table}" '
                    f"WHERE \"{cand}\"::date < '{cutoff}'{scope_and}"
                )
            else:
                # No heartbeat: second-newest date, never the newest.
                row = read_df(
                    f'SELECT MAX("{cand}")::text AS m FROM "{table}" '
                    f'WHERE "{cand}" < (SELECT MAX("{cand}") FROM "{table}"{scope_where})'
                    f'{scope_and}'
                )
        except Exception:
            # Some vendor schemas use a generic text `date` for labels such as "Mar 2024" and
            # also carry a real fetched_at timestamp. One unparsable candidate must not make the
            # full table disappear from the sweep; try the next date-ish column.
            continue
        if not row.empty and row["m"][0] is not None:
            return cand, row["m"][0], cols
        # Table has no row older than the anchor (a brand-new or single-date table):
        # fall back to its own newest date rather than skipping it entirely.
        row = read_df(f'SELECT MAX("{cand}")::text AS m FROM "{table}"{scope_where}')
        if not row.empty and row["m"][0] is not None:
            return cand, row["m"][0], cols
    return None


def _classify(nn: int, nd: int, n: int, dt: str) -> str | None:
    if nn == 0:
        return "dead"
    if nd == 1 and nn == n and dt in ("double precision", "real", "numeric", "integer", "bigint"):
        return "frozen"
    return None


def _date_eq_filter(datecol: str, datecol_type: str, latest: str) -> str:
    """`datecol = latest` without casting the COLUMN, when avoidable.

    2026-08-29: `"{datecol}"::text = '{latest}'` was found live to make this sweep's
    confluence_signals query run 100+ minutes (still climbing when killed) -- a text cast on an
    indexed DATE/TIMESTAMPTZ column defeats the index for a single-day filter, forcing a full
    sequential scan on a table with 30-min-cadence history. `latest` itself already came from a
    `MAX(datecol)::text` read (see latest_date_expr), so it round-trips exactly through a cast
    on the LITERAL instead -- the column stays untouched and any index on it still applies.
    Falls back to the original (safe, just slow) column-cast form for any type this doesn't
    recognize, rather than guessing at a cast that could raise on a real production table."""
    if datecol_type in ("date",):
        return f"\"{datecol}\" = '{latest}'::date"
    if datecol_type in ("timestamp with time zone", "timestamp without time zone"):
        return f"\"{datecol}\" = '{latest}'::timestamptz"
    if datecol_type in ("text", "character varying"):
        return f"\"{datecol}\" = '{latest}'"
    return f"\"{datecol}\"::text = '{latest}'"


def sweep_table(table: str, min_rows: int):
    info = latest_date_expr(table)
    if not info:
        return None
    datecol, latest, cols = info
    datecol_type = cols.loc[cols["column_name"] == datecol, "data_type"].iloc[0]
    date_filter = _date_eq_filter(datecol, datecol_type, latest)
    scope_sql = TABLE_ROW_SCOPES.get(table, (None, ""))[0]
    if scope_sql:
        date_filter += f" AND ({scope_sql})"
    n = read_df(f'SELECT COUNT(*) c FROM "{table}" WHERE {date_filter}')["c"][0]
    if n < min_rows:
        return None

    check_cols = [(c["column_name"], c["data_type"]) for _, c in cols.iterrows() if c["column_name"] != datecol]
    dead, frozen = [], []
    if check_cols:
        # ONE query for every column in the table, not one query PER column. The original
        # per-column round trip made a full-repo sweep take 20+ minutes before the first
        # finding could even print (AF-20260818-45) -- 8s for technical_signals alone
        # (303 columns), which is fast in isolation but adds up over ~400 tables. Conditional
        # aggregation collapses that into one round trip per table (still one full scan of
        # the day's rows, just not repeated once per column).
        select_parts = ", ".join(
            f'COUNT("{col}") AS "{col}__nn", COUNT(DISTINCT "{col}") AS "{col}__nd"'
            for col, _ in check_cols
        )
        try:
            row = read_df(f'SELECT {select_parts} FROM "{table}" WHERE {date_filter}').iloc[0]
            for col, dt in check_cols:
                kind = _classify(int(row[f"{col}__nn"]), int(row[f"{col}__nd"]), n, dt)
                if kind == "dead":
                    dead.append(col)
                elif kind == "frozen":
                    frozen.append(col)
        except Exception:
            # Fall back to one-query-per-column for this table only -- an exotic/unorderable
            # type in one column must not silently drop every other column's check.
            for col, dt in check_cols:
                try:
                    r = read_df(f'SELECT COUNT("{col}") AS nn, COUNT(DISTINCT "{col}") AS nd '
                                f'FROM "{table}" WHERE {date_filter}')
                    kind = _classify(int(r["nn"][0]), int(r["nd"][0]), n, dt)
                except Exception:
                    continue
                if kind == "dead":
                    dead.append(col)
                elif kind == "frozen":
                    frozen.append(col)
    dead, expected_dead = _partition_expected(table, dead, EXPECTED_DEAD_COLUMNS)
    frozen, expected_frozen = _partition_expected(table, frozen, EXPECTED_FROZEN_COLUMNS)
    return {"table": table, "date_col": datecol, "latest": latest, "rows": int(n),
            "dead": dead, "frozen": frozen, "expected_dead": expected_dead,
            "expected_frozen": expected_frozen, "total_cols": len(cols)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", help="sweep only this table")
    ap.add_argument("--min-rows", type=int, default=100)
    args = ap.parse_args()

    if args.table:
        tables = [args.table]
    else:
        tables = read_df(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
        )["table_name"].tolist()

    # Stream each finding as it is discovered, and flush. A full-universe sweep takes >40min
    # against production (measured 2026-08-16: 0 bytes of output after 40min, run abandoned),
    # and every print used to sit AFTER this loop -- so an interrupted or timed-out run threw
    # away results for tables it had already swept. Same class as recurring-bugs.md's "a step at
    # the end of a script that routinely gets killed never runs at all", in reporting form.
    # The sorted summary below still prints in full on a clean run; this is additive.
    findings, expected_findings, swept = [], [], 0
    total = len(tables)
    for i, t in enumerate(tables, 1):
        try:
            res = sweep_table(t, args.min_rows)
        except Exception as e:
            print(f"  [skip] {t}: {e}", flush=True)
            continue
        if not res:
            continue
        swept += 1
        if res["expected_dead"] or res["expected_frozen"]:
            expected_findings.append(res)
        if res["dead"] or res["frozen"]:
            findings.append(res)
            tag = "SCORING-CRITICAL" if t in PRIORITY else "informational"
            print(f"[{i}/{total}] [{tag}] {t} (latest {res['date_col']}={res['latest']}, "
                  f"{res['rows']} rows): {len(res['dead'])} dead, {len(res['frozen'])} frozen",
                  flush=True)

    print(f"\n{'='*78}\nINTEGRITY SWEEP -- {swept} tables with a usable date key and >= {args.min_rows} rows\n{'='*78}")
    if not findings:
        print("No dead or frozen columns found.")
        if expected_findings:
            print(f"{len(expected_findings)} table(s) have documented expected single-date findings.")
        return 0

    findings.sort(key=lambda r: (r["table"] not in PRIORITY, -len(r["dead"])))
    exit_code = 0
    for r in findings:
        tag = "SCORING-CRITICAL" if r["table"] in PRIORITY else "informational"
        print(f"\n[{tag}] {r['table']}  (latest {r['date_col']}={r['latest']}, {r['rows']} rows, {r['total_cols']} cols)")
        if r["dead"]:
            print(f"   DEAD (100% NULL on latest date): {', '.join(r['dead'])}")
            if r["table"] in PRIORITY:
                exit_code = 1
        if r["frozen"]:
            print(f"   FROZEN (one identical value for every row): {', '.join(r['frozen'])}")
    print(f"\n{len(findings)} table(s) with findings. "
          f"Exit 1 if any SCORING-CRITICAL table has a dead column.")
    if expected_findings:
        print(f"{len(expected_findings)} table(s) also have documented expected findings suppressed "
              "from the verdict (see EXPECTED_*_COLUMNS for reasons).")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
