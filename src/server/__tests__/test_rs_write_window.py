"""relative_strength must write only the dates that can still change.

Live 2026-09-06: the ml-daily-ops step `relative_strength` was killed at its 300s budget. The
budget was not the problem -- run standalone the script completes its computation in 39.8s and
then dies on a LOCK TIMEOUT:

    while locking tuple (154,3) in relation "technical_signals"
    ... displaying 10 of 99866 total bound parameter sets ...

It issues a ~99,866-row UPDATE against technical_signals, which holds ~106,500 rows -- i.e. it
rewrites essentially the whole table every night, while other ml-daily-ops steps are writing the
same table. Raising the timeout would have made the lock footprint worse, not better; this is
recurring-bugs.md's "diagnose lock contention before theorizing about cost".

The write is also unnecessary. rs_rank_21d/63d are CROSS-SECTIONAL percentiles as of date D,
computed from a window ending at D. Once D's bars are final the value is final -- so re-writing
four months of history nightly is write amplification, the same class as the "per-call API with
no since-parameter" entry.

LOOKBACK_DAYS stays 420 because the RETURNS need that history to be computed. Only the WRITE set
narrows.
"""
import datetime
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from relative_strength import rows_to_write


def frame(dates):
    return pd.DataFrame({"symbol": ["AAA"] * len(dates), "date": list(dates), "rs_rank_21d": 0.5})


def test_writes_only_recent_dates_by_default():
    """The boundary is inclusive: `date >= today - window_days`, so window_days=3 on the 7th
    keeps the 4th onward. Stated explicitly because the first version of this test assumed an
    exclusive boundary and the implementation is the clearer of the two."""
    d = [f"2026-09-{n:02d}" for n in range(1, 8)]
    out = rows_to_write(frame(d), today=datetime.date(2026, 9, 7), window_days=3)
    assert set(out["date"]) == {"2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"}


def test_old_dates_are_excluded_even_though_they_were_computed():
    """The whole point: 420 days are computed so the returns are right; a fraction are written."""
    d = [f"2026-0{m}-01" for m in (5, 6, 7, 8, 9)]
    out = rows_to_write(frame(d), today=datetime.date(2026, 9, 7), window_days=10)
    assert list(out["date"]) == ["2026-09-01"]


def test_full_backfill_writes_everything():
    """First run on an empty column, or after a bhavcopy reconciliation restates old bars."""
    d = [f"2026-0{m}-01" for m in (5, 6, 7, 8, 9)]
    out = rows_to_write(frame(d), today=datetime.date(2026, 9, 7), window_days=0)
    assert len(out) == 5


def test_an_empty_frame_stays_empty_rather_than_raising():
    out = rows_to_write(pd.DataFrame(columns=["symbol", "date", "rs_rank_21d"]),
                        today=datetime.date(2026, 9, 7), window_days=10)
    assert out.empty


def test_the_window_is_calendar_days_and_covers_a_long_weekend():
    """A Monday run must still reach the previous Thursday's row: a 3-calendar-day window over a
    Fri->Mon gap can otherwise contain no trading session at all (recurring-bugs.md's short
    calendar-day lookback class). 10 days is chosen to survive a long weekend plus a holiday."""
    d = ["2026-09-03", "2026-09-04", "2026-09-07"]  # Thu, Fri, Mon
    out = rows_to_write(frame(d), today=datetime.date(2026, 9, 7), window_days=10)
    assert set(out["date"]) == {"2026-09-03", "2026-09-04", "2026-09-07"}
