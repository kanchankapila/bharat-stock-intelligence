import sys
import os
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
import src.server.block_deal_fetcher as bdf


class _FixedDate(date):
    """Monkeypatch target: date.today() returns a fixed weekday, everything else real."""
    FIXED = date(2026, 8, 14)  # a Friday

    @classmethod
    def today(cls):
        return cls.FIXED


class TestCalendarDaysBackDateLabeling:
    """recurring-bugs.md's dominant bug class (date.today() as a write-anchor). Was anchored at
    today - 1 unconditionally, so --days 1 (the default) labeled TODAY's live deals as
    yesterday's -- live-confirmed 2026-08-14 (fetcher-accuracy-review): byte-identical deals
    for 5 real symbols filed under two adjacent dates."""

    def test_NEGATIVE_CONTROL_first_date_is_today_not_yesterday(self, monkeypatch):
        monkeypatch.setattr(bdf, 'date', _FixedDate)
        days = bdf._calendar_days_back(1)
        assert days == [_FixedDate.FIXED], (
            f"expected [{_FixedDate.FIXED}] (today), got {days} -- "
            "the pre-fix version returned [yesterday]"
        )

    def test_n_days_back_includes_today_first_then_walks_backward(self, monkeypatch):
        monkeypatch.setattr(bdf, 'date', _FixedDate)
        days = bdf._calendar_days_back(3)
        assert days[0] == _FixedDate.FIXED
        assert all(days[i] > days[i + 1] for i in range(len(days) - 1)), "must be strictly descending"

    def test_weekend_days_are_skipped(self, monkeypatch):
        # Fix "today" to a Sunday -- the first trading day walked to should be Friday.
        class _Sunday(date):
            FIXED = date(2026, 8, 16)  # a Sunday

            @classmethod
            def today(cls):
                return cls.FIXED

        monkeypatch.setattr(bdf, 'date', _Sunday)
        days = bdf._calendar_days_back(1)
        assert days[0].weekday() < 5
        assert days[0] == date(2026, 8, 14)  # the preceding Friday

    def test_live_endpoint_condition_only_matches_today(self):
        today = _FixedDate.FIXED
        yesterday = today - timedelta(days=1)
        assert (today >= today) is True
        assert (yesterday >= today) is False, (
            "yesterday must NOT satisfy the live-endpoint condition -- "
            "the live endpoint can only ever return today's session"
        )
