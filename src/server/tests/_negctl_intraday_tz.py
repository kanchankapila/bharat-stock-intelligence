"""Negative control for test_intraday_news_window_tz.py: repoint its helper at the OLD
bare-date expressions and confirm the assertions actually fire. Run:
    python src/server/tests/_negctl_intraday_tz.py
"""
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import test_intraday_news_window_tz as m


def _old_bounds(days=2):
    """Exactly what the code did before the fix."""
    return (datetime.fromisoformat((date.today() - timedelta(days=days)).isoformat()),
            datetime.fromisoformat((date.today() + timedelta(days=1)).isoformat()))


m._bounds = _old_bounds
for fn in (m.test_window_bounds_are_tz_aware_instants,
           m.test_cutoff_does_not_snap_to_midnight,
           m.test_cutoff_tracks_wall_clock_not_the_calendar_date):
    try:
        fn()
        print(f"  {fn.__name__}: PASSED (did NOT catch the old code)")
    except AssertionError as e:
        print(f"  {fn.__name__}: FAILED as intended -> {str(e)[:70]}")
