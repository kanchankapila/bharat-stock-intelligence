"""One-off repair for the 2026-08-13 days_to_next_results anchor bug (mc_earnings_fetcher.py).

_backfill_days_to_results() computed "days until results" against real wall-clock
(CURRENT_DATE / julianday('now')) while writing into a row keyed by logical_trading_date() --
two different clocks whenever the nightly chain crosses midnight IST, which it does regularly.
Measured live 2026-08-13: 84.6% of 37,593 symbol-days across the prior 34 trading days were
wrong (NULL or a stale day-count) under the old code, most nights 100% wrong.

The forward fix only writes into `ts.date = logical_trading_date()`, so historical rows stay
broken until repaired. This script re-runs the SAME corrected function once per historical
trading day, passing that date as `as_of` -- not a new code path, just driving the fixed one
over history. Read-only against stock_earnings_dates; only technical_signals.days_to_next_results
is written.

Usage:
    python backfill_days_to_next_results.py                    # repairs from 2026-06-30
    python backfill_days_to_next_results.py --since 2026-08-01
    python backfill_days_to_next_results.py --dry-run
"""
from __future__ import annotations

import polars as pl
import argparse

from db_compat import connect, read_df
from mc_earnings_fetcher import _backfill_days_to_results

DEFAULT_SINCE = '2026-06-30'  # stock_earnings_dates has negligible coverage before this


def run(since: str = DEFAULT_SINCE, dry_run: bool = False) -> dict:
    con = connect()
    dates = sorted(read_df(
        "SELECT DISTINCT date FROM stock_ohlcv WHERE date >= ? AND date <= CURRENT_DATE",
        (since,),
    )['date'].astype(str))
    if dry_run:
        print(f"[Backfill] would repair {len(dates)} trading days from {since}")
        return {'dates': len(dates), 'dry_run': True}

    for d in dates:
        _backfill_days_to_results(con, as_of=d)
    print(f"[Backfill] repaired days_to_next_results for {len(dates)} trading days ({since} .. {dates[-1] if dates else since})")
    return {'dates': len(dates)}


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--since', default=DEFAULT_SINCE)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    print(run(since=a.since, dry_run=a.dry_run))

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
