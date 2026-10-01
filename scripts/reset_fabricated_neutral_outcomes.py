"""
Reset the 0.0% NEUTRAL labels expire_stale_pending fabricated for PRICEABLE rows back to PENDING,
so the (now paged) outcome_resolver regrades them from real bars (AF-20261001-30).

Signature of a fabricated label: outcome NEUTRAL, return exactly 0.0, NO exit price, and the
symbol has a canonical (non-suspect) daily bar after the signal. A real resolver NEUTRAL always
carries an exit price (time exit) and a SUSPECT_DATA one carries a NULL return, so neither
matches. Measured 2026-10-01: unified_signal_outcomes 42,808 (all h1), signal_outcomes
'technical' 21,706 (h1), recommendation_log 866; plus 9,023 recommendation_log rows
carrying the h1 technical label stamped by performance_tracker (AF-20261001-36).

USAGE (from repo root, backend-python venv)
  python scripts/reset_fabricated_neutral_outcomes.py                    # dry run: counts only
  python scripts/reset_fabricated_neutral_outcomes.py --apply --backup-dir backups/af-20261001-30
Then run outcome_resolver.py --horizon 1, 5 and 15 (each pass pages up to 40k rows).
--apply writes a CSV of every row it touches BEFORE the UPDATE, and commits all three tables
in one transaction.
"""
import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "server"))
from db_compat import connect  # noqa: E402

_TRADED = ("EXISTS (SELECT 1 FROM stock_ohlcv o WHERE o.symbol = t.symbol "
           "AND o.date > CAST(t.signal_date AS date) AND COALESCE(o.is_suspect, 0) = 0)")

_REC_RESET = "outcome = 'PENDING', actual_return_pct = NULL, status = 'ACTIVE', resolved_at = NULL"

# name -> (table, fabrication predicate, SET clause)
TARGETS = {
    "unified_signal_outcomes": (
        "unified_signal_outcomes",
        "t.outcome = 'NEUTRAL' AND t.return_pct = 0.0 AND t.exit_price IS NULL",
        "outcome = 'PENDING', return_pct = NULL, computed_at = CURRENT_TIMESTAMP"),
    "signal_outcomes": (
        "signal_outcomes",
        "t.signal_source = 'technical' AND t.outcome = 'NEUTRAL' AND t.return_pct = 0.0 "
        "AND t.exit_price IS NULL",
        "outcome = 'PENDING', return_pct = NULL, computed_at = CURRENT_TIMESTAMP"),
    "recommendation_log": (
        "recommendation_log",
        "t.outcome = 'NEUTRAL' AND t.actual_return_pct = 0.0 AND t.actual_exit_price IS NULL",
        _REC_RESET),
    # AF-20261001-36: performance_tracker stamped the h1 technical label onto multi-session
    # recommendations (exact exit AND return match; live 9,023 rows all-time).
    "recommendation_log_h1_stamped": (
        "recommendation_log",
        "t.status = 'RESOLVED' AND COALESCE(t.horizon_days, 15) > 1 AND EXISTS ("
        "SELECT 1 FROM signal_outcomes so WHERE so.symbol = t.symbol "
        "AND so.signal_date = t.signal_date AND so.signal_source = 'technical' "
        "AND so.horizon_days = 1 AND so.exit_price = t.actual_exit_price "
        "AND so.return_pct = t.actual_return_pct)",
        _REC_RESET),
}


def where(name: str) -> str:
    return f"{TARGETS[name][1]} AND {_TRADED}"


def run(conn, apply: bool, backup_dir: str | None) -> dict:
    counts = {}
    for name, (table, _, _) in TARGETS.items():
        counts[name] = conn.execute(f"SELECT COUNT(*) FROM {table} t WHERE {where(name)}").fetchone()[0]
    print(f"[reset] fabricated rows: {counts}")
    if not apply:
        print("[reset] dry run -- nothing written. Re-run with --apply --backup-dir DIR.")
        return counts
    os.makedirs(backup_dir, exist_ok=True)
    for name, (table, _, _) in TARGETS.items():
        cur = conn.execute(f"SELECT t.* FROM {table} t WHERE {where(name)}")
        cols = [d[0] for d in cur.description]
        path = os.path.join(backup_dir, f"{name}.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols)
            w.writerows(cur.fetchall())
        print(f"[reset] backed up {counts[name]} rows -> {path}")
    for name, (table, _, set_clause) in TARGETS.items():
        conn.execute(f"UPDATE {table} t SET {set_clause} WHERE {where(name)}")
    conn.commit()
    print("[reset] committed. Now run outcome_resolver.py --horizon 1/5/15.")
    return counts


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--backup-dir")
    a = ap.parse_args()
    if a.apply and not a.backup_dir:
        ap.error("--apply needs --backup-dir (CSV backup is written before the UPDATE)")
    c = connect()
    try:
        run(c, a.apply, a.backup_dir)
    finally:
        c.close()
