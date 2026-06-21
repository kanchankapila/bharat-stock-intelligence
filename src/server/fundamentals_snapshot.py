"""
Fundamentals Snapshotter
=========================
stock_fundamentals holds only the *current* values. Joining it onto historical signal rows
(as ml_ensemble did) leaks future fundamentals into training. This script appends today's
fundamentals into fundamentals_history(symbol, as_of_date), building the point-in-time trail
ml_ensemble.load_training_data joins as-of each signal_date.

Idempotent per day: re-running overwrites today's snapshot. Run daily, after the
fundamentals sync. The leakage fix improves with every day this accumulates; until enough
history exists, the ensemble falls back to the current snapshot (no regression).

Run:  python fundamentals_snapshot.py
      python fundamentals_snapshot.py --as-of 2026-06-21
"""

import argparse
import datetime

from db_compat import execute

# SQLite cannot parse `INSERT ... SELECT ... ON CONFLICT` (parser ambiguity with the SELECT's
# ON). Delete-then-insert-select is idempotent per day and portable to Postgres.
_DELETE_SQL = "DELETE FROM fundamentals_history WHERE as_of_date = ?"
_INSERT_SQL = """
INSERT INTO fundamentals_history
    (symbol, as_of_date, fifty_two_week_high, piotroski_f_score, debt_to_equity,
     operating_margins, return_on_equity, revenue_growth, earnings_growth,
     earnings_yield, price_to_book, market_cap)
SELECT symbol, ?, fifty_two_week_high, piotroski_f_score, debt_to_equity,
       operating_margins, return_on_equity, revenue_growth, earnings_growth,
       earnings_yield, price_to_book, market_cap
FROM stock_fundamentals
"""


def run(as_of: str | None = None) -> int:
    """Snapshot current stock_fundamentals into fundamentals_history for `as_of` (default
    today). Idempotent: re-running overwrites that day's snapshot. Returns rows written."""
    as_of = as_of or datetime.date.today().isoformat()
    execute(_DELETE_SQL, (as_of,))
    n = execute(_INSERT_SQL, (as_of,))
    print(f"[FUND-SNAP] Wrote {n} fundamentals snapshots as_of {as_of}.")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Point-in-time fundamentals snapshotter")
    parser.add_argument("--as-of", help="Snapshot date YYYY-MM-DD (default: today)")
    args = parser.parse_args()
    run(as_of=args.as_of)
