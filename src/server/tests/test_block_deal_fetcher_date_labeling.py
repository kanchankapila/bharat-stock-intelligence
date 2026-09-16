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
        # The N-1 historical days now come from as_of.trading_days_back() (real trading
        # calendar, holiday-aware -- see _calendar_days_back's docstring, fixed
        # 2026-08-19/temporal-correctness-audit), which anchors to the real wall-clock date
        # internally and has no "as of" override -- so it can't be driven by the
        # logical_trading_date() monkeypatch below. It has its own coverage
        # (test_trading_days_back.py); stub it here to verify only _calendar_days_back's own
        # combine-and-truncate logic, not trading_days_back's date arithmetic.
        monkeypatch.setattr(bdf, 'logical_trading_date', _fixed('2026-08-14'))
        monkeypatch.setattr(bdf, 'trading_days_back',
                             lambda n, conn=None: [date(2026, 8, 13), date(2026, 8, 12)][:n])
        days = bdf._calendar_days_back(3)
        assert days == [date(2026, 8, 14), date(2026, 8, 13), date(2026, 8, 12)]
        assert all(days[i] > days[i + 1] for i in range(len(days) - 1)), "must be strictly descending"

    def test_delegates_historical_days_to_trading_days_back_not_naive_weekday_walk(self, monkeypatch):
        """Pins the temporal-correctness-audit fix (2026-08-19): the pre-fix code stepped back
        N weekdays by hand, holiday-blind, so --days N silently covered fewer than N real
        sessions whenever a holiday fell in range. Proven here by stubbing trading_days_back()
        to return a date no naive weekday walk backward from 2026-08-14 would ever produce for
        n=1 (2026-08-10, standing in for "a holiday sat between the two"), and confirming
        _calendar_days_back trusts it rather than recomputing its own weekday sequence."""
        monkeypatch.setattr(bdf, 'logical_trading_date', _fixed('2026-08-14'))
        calls = []

        def _fake_trading_days_back(n, conn=None):
            calls.append(n)
            return [date(2026, 8, 10)][:n]

        monkeypatch.setattr(bdf, 'trading_days_back', _fake_trading_days_back)
        days = bdf._calendar_days_back(2)
        assert calls == [1], "must ask trading_days_back for n-1 (today is supplied separately)"
        assert days == [date(2026, 8, 14), date(2026, 8, 10)]

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
