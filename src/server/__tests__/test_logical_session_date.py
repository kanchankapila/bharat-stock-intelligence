"""Pins as_of.logical_session_date() -- the weekend anchor for unified_recommendations.computed_at.

The bug this prevents: the daily pipeline deliberately runs early on closed days, so
date.today() as the computed_at label put 9,096 rows on Saturdays and Sundays (2026-07-05,
07-12, 07-25, 08-09), unreachable to any consumer joining on a real trading date.
"""
import datetime
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import as_of  # noqa: E402


def at(y, m, d, hh=9, mm=0):
    return datetime.datetime(y, m, d, hh, mm)


class TestWeekendRollForward:
    # The four dates the reverse audit actually found in unified_recommendations.
    @pytest.mark.parametrize("weekend, expected_session", [
        ((2026, 7, 5), "2026-07-06"),    # Sunday  -> Monday
        ((2026, 7, 12), "2026-07-13"),   # Sunday  -> Monday
        ((2026, 7, 25), "2026-07-27"),   # Saturday-> Monday (skips Sunday too)
        ((2026, 8, 9), "2026-08-10"),    # Sunday  -> Monday
    ])
    def test_the_four_bad_dates_now_land_on_a_weekday(self, weekend, expected_session):
        got = as_of.logical_session_date(now=at(*weekend))
        assert got == expected_session
        assert datetime.date.fromisoformat(got).weekday() < 5

    def test_saturday_rolls_two_days(self):
        assert as_of.logical_session_date(now=at(2026, 8, 8)) == "2026-08-10"


class TestWeekdaysAreUnchanged:
    """The whole point is that a normal run keeps today's date -- rolling forward on a
    weekday would label a pre-market run with the WRONG (future) session and, worse,
    anchoring to the last completed session instead would overwrite the previous day's
    snapshot. Both are silent."""

    @pytest.mark.parametrize("day", [
        (2026, 8, 10), (2026, 8, 11), (2026, 8, 12), (2026, 8, 13), (2026, 8, 14),
    ])
    def test_mon_to_fri_are_returned_as_is(self, day):
        assert as_of.logical_session_date(now=at(*day)) == datetime.date(*day).isoformat()

    def test_it_still_matches_logical_trading_date_on_a_weekday(self):
        now = at(2026, 8, 12, 7, 30)
        assert as_of.logical_session_date(now=now) == as_of.logical_trading_date(now=now)


class TestMidnightCrossingStillWorks:
    """The cutoff_hour behaviour of the WRAPPED logical_trading_date is unchanged; what this
    class pins is that logical_session_date then answers its own question -- which session is
    this ranking FOR -- rather than inheriting "which trading day is being processed".

    Both expectations below were changed 2026-08-12 (previously 2026-08-10 and 2026-08-07).
    The old values labelled a ranking with a session whose 09:15 open had already passed, which
    nobody could act on and which made the row ungradeable: entry has to be an open that is
    still ahead of the signal. See the open-passed roll-forward in as_of.logical_session_date.
    """

    def test_small_hours_run_targets_the_session_that_has_not_opened_yet(self):
        # Tue 02:00: Monday's session closed 17h ago, so this ranking is for TUESDAY -- and
        # 02:00 IST is genuinely pre-market for it. This is the exact shape of the real
        # 2026-08-11 batch (20:02 UTC = 01:32 IST Wed), which was stamped with the closed
        # Tuesday session instead of the Wednesday it was actually actionable for.
        assert as_of.logical_session_date(now=at(2026, 8, 11, 2, 0)) == "2026-08-11"

    def test_after_cutoff_hour_but_before_the_open_is_today(self):
        # 04:00 IST, well inside the pre-market window -> today, unchanged.
        assert as_of.logical_session_date(now=at(2026, 8, 11, 4, 0)) == "2026-08-11"

    def test_a_run_after_the_open_rolls_to_the_next_session(self):
        # 23:53 IST Monday -- the real 2026-08-10 batch (18:23 UTC). Monday has closed, so the
        # next session this can be acted on is Tuesday.
        assert as_of.logical_session_date(now=at(2026, 8, 10, 23, 53)) == "2026-08-11"

    def test_saturday_small_hours_roll_to_monday_not_back_to_friday(self):
        """Sat 02:00 is the tail of Friday's post-close chain, but Friday's open is long gone.
        A ranking produced then is actionable at Monday's open, not Friday's."""
        assert as_of.logical_session_date(now=at(2026, 8, 8, 2, 0)) == "2026-08-10"


def test_return_type_is_an_iso_date_string():
    v = as_of.logical_session_date(now=at(2026, 8, 9))
    assert isinstance(v, str)
    assert datetime.date.fromisoformat(v)
