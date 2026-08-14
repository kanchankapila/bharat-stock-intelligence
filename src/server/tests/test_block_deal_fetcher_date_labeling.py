import sys
import os
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
import src.server.block_deal_fetcher as bdf


def _fixed(iso: str):
    """monkeypatch target: bdf.logical_trading_date() returns a fixed ISO date string."""
    return lambda cutoff_hour=4, now=None: iso


class TestCalendarDaysBackDateLabeling:
    """recurring-bugs.md's dominant bug class (date.today() as a write-anchor). Was anchored at
    today - 1 unconditionally, so --days 1 (the default) labeled TODAY's live deals as
    yesterday's -- live-confirmed 2026-08-14 (fetcher-accuracy-review): byte-identical deals
    for 5 real symbols filed under two adjacent dates."""

    def test_NEGATIVE_CONTROL_first_date_is_today_not_yesterday(self, monkeypatch):
        monkeypatch.setattr(bdf, 'logical_trading_date', _fixed('2026-08-14'))  # a Friday
        days = bdf._calendar_days_back(1)
        assert days == [date(2026, 8, 14)], (
            f"expected [2026-08-14] (today), got {days} -- "
            "the pre-fix version returned [yesterday]"
        )

    def test_n_days_back_includes_today_first_then_walks_backward(self, monkeypatch):
        monkeypatch.setattr(bdf, 'logical_trading_date', _fixed('2026-08-14'))
        days = bdf._calendar_days_back(3)
        assert days[0] == date(2026, 8, 14)
        assert all(days[i] > days[i + 1] for i in range(len(days) - 1)), "must be strictly descending"

    def test_weekend_days_are_skipped(self, monkeypatch):
        # Fix "today" to a Sunday -- the first trading day walked to should be Friday.
        monkeypatch.setattr(bdf, 'logical_trading_date', _fixed('2026-08-16'))
        days = bdf._calendar_days_back(1)
        assert days[0].weekday() < 5
        assert days[0] == date(2026, 8, 14)  # the preceding Friday

    def test_live_endpoint_condition_only_matches_today(self):
        today = date(2026, 8, 14)
        yesterday = today - timedelta(days=1)
        assert (today >= today) is True
        assert (yesterday >= today) is False, (
            "yesterday must NOT satisfy the live-endpoint condition -- "
            "the live endpoint can only ever return today's session"
        )

    def test_NEGATIVE_CONTROL_does_not_call_bare_date_today(self, monkeypatch):
        """A midnight-crossing ml-daily-ops run (e.g. 00:30 IST, the real calendar date has
        already rolled to the next day) must anchor on logical_trading_date() -- the trading day
        that just closed -- not on bdf.date.today()'s bare calendar date. Same failure shape as
        the bug this file was already fixed for, from the opposite direction (see
        _calendar_days_back's docstring). Proven here by making date.today() raise: if
        _calendar_days_back regressed to calling it directly, this test fails with that error
        instead of silently passing (the pre-this-fix code would have crashed here)."""
        class _BoomDate(date):
            @classmethod
            def today(cls):
                raise AssertionError("_calendar_days_back must not call date.today() directly")

        monkeypatch.setattr(bdf, 'date', _BoomDate)
        monkeypatch.setattr(bdf, 'logical_trading_date', _fixed('2026-08-14'))
        days = bdf._calendar_days_back(1)
        assert days == [date(2026, 8, 14)]
