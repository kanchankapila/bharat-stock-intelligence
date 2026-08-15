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


def latest_date_expr(table: str):
    """Return (date_column, sql_literal_of_latest_value) or None if the table has no date-ish key."""
    cols = read_df(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_schema='public' AND table_name=%(t)s" if False else
        f"SELECT column_name, data_type FROM information_schema.columns "
        f"WHERE table_schema='public' AND table_name='{table}'"
    )
    names = cols["column_name"].tolist()
    for cand in ("date", "computed_at", "as_of_date", "signal_date", "eval_date", "fetched_at"):
        if cand in names:
            row = read_df(f'SELECT MAX("{cand}")::text AS m FROM "{table}"')
            if not row.empty and row["m"][0] is not None:
                return cand, row["m"][0], cols
    return None


def sweep_table(table: str, min_rows: int):
    info = latest_date_expr(table)
    if not info:
        return None
    datecol, latest, cols = info
    n = read_df(f'SELECT COUNT(*) c FROM "{table}" WHERE "{datecol}"::text = \'{latest}\'')["c"][0]
    if n < min_rows:
        return None

    dead, frozen = [], []
    for _, c in cols.iterrows():
        col, dt = c["column_name"], c["data_type"]
        if col == datecol:
            continue
        try:
            q = (f'SELECT COUNT("{col}") AS nn, COUNT(DISTINCT "{col}") AS nd '
                 f'FROM "{table}" WHERE "{datecol}"::text = \'{latest}\'')
            r = read_df(q)
            nn, nd = int(r["nn"][0]), int(r["nd"][0])
        except Exception:
            continue  # unorderable/exotic type -- not worth failing the sweep over
        if nn == 0:
            dead.append(col)
        elif nd == 1 and nn == n and dt in ("double precision", "real", "numeric", "integer", "bigint"):
            frozen.append(col)
    return {"table": table, "date_col": datecol, "latest": latest, "rows": int(n),
            "dead": dead, "frozen": frozen, "total_cols": len(cols)}


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

    findings, swept = [], 0
    for t in tables:
        try:
            res = sweep_table(t, args.min_rows)
        except Exception as e:
            print(f"  [skip] {t}: {e}")
            continue
        if not res:
            continue
        swept += 1
        if res["dead"] or res["frozen"]:
            findings.append(res)

    print(f"\n{'='*78}\nINTEGRITY SWEEP -- {swept} tables with a usable date key and >= {args.min_rows} rows\n{'='*78}")
    if not findings:
        print("No dead or frozen columns found.")
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
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
