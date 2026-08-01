"""Regression tests for as_of.trading_days_back() and delivery_volume_fetcher's fetch contract.

Full-stack audit line 1161 flagged two defects in the same file, both silent:

  * `_trading_days_back` stepped back over weekdays only, with no holiday awareness, so
    `--days N` covered fewer than N real sessions whenever a holiday fell in range. Measured
    live over a 90-session window: 3 wasted fetches on real holidays (2026-04-14 Ambedkar
    Jayanti, 2026-04-03 Good Friday, 2026-03-31 Eid) and 5 calendar days of lost reach.
  * `fetch_mto` returned None for BOTH a holiday and a genuine failure, so a throttled or
    broken run was indistinguishable from a run of holidays -- the same contract bug already
    fixed in insider_transactions_fetcher.py.

The identical `_trading_days_back` copy in fno_rollover_fetcher.py now shares the helper too.
"""
import datetime
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from as_of import trading_days_back  # noqa: E402


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _Conn:
    """Minimal stand-in exposing only what the helper uses."""

    def __init__(self, dates=None, fail_tables=()):
        self._dates = dates or []
        self._fail = set(fail_tables)
        self.rolled_back = False

    def execute(self, sql, params=()):
        for t in self._fail:
            if t in sql:
                raise RuntimeError(f"no such table: {t}")
        return _Rows([(d,) for d in self._dates])

    def rollback(self):
        self.rolled_back = True


def _iso_back(days_ago):
    return (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()


class TestTradingDaysBack:
    def test_returns_real_sessions_newest_first(self):
        dates = [_iso_back(i) for i in range(1, 8)]
        got = trading_days_back(3, _Conn(dates))
        assert got == [datetime.date.fromisoformat(d) for d in dates[:3]]

    def test_skips_holidays_because_they_are_absent_from_the_session_list(self):
        """The whole point: a holiday simply has no row, so it can never be returned --
        unlike the weekday heuristic, which would happily hand back Good Friday."""
        sessions = [_iso_back(1), _iso_back(2), _iso_back(6), _iso_back(7)]
        got = trading_days_back(4, _Conn(sessions))
        assert [d.isoformat() for d in got] == sessions
        gap = (got[1] - got[2]).days
        assert gap > 1, "expected a multi-day gap to survive, i.e. holidays not filled in"

    def test_excludes_today(self):
        """Today's session may still be open or its file unpublished -- the same reason the
        original weekday version started at today-1."""
        dates = [datetime.date.today().isoformat()] + [_iso_back(i) for i in (1, 2, 3)]
        got = trading_days_back(2, _Conn(dates))
        assert datetime.date.today() not in got

    def test_accepts_date_objects_as_well_as_iso_strings(self):
        """stock_ohlcv.date is a native DATE in Postgres but TEXT on the SQLite fallback."""
        dates = [datetime.date.today() - datetime.timedelta(days=i) for i in (1, 2, 3)]
        got = trading_days_back(2, _Conn(dates))
        assert got == dates[:2]

    def test_falls_back_to_the_second_table(self):
        dates = [_iso_back(i) for i in (1, 2, 3)]
        conn = _Conn(dates, fail_tables=("stock_ohlcv",))
        got = trading_days_back(2, conn)
        assert len(got) == 2
        assert conn.rolled_back, "a failed statement must be rolled back or Postgres poisons the tx"

    def test_falls_back_to_weekdays_when_no_table_is_readable(self):
        """A fetcher should still run (slightly over-broad, 404ing on a holiday) rather than
        failing outright because the calendar could not be read."""
        conn = _Conn([], fail_tables=("stock_ohlcv", "nse_universe_history"))
        got = trading_days_back(5, conn)
        assert len(got) == 5
        assert all(d.weekday() < 5 for d in got)

    def test_zero_or_negative_returns_empty(self):
        assert trading_days_back(0, _Conn([])) == []
        assert trading_days_back(-3, _Conn([])) == []


class TestFetchMtoContract:
    def test_holiday_returns_empty_list_and_failure_returns_none(self):
        """[] means 'no session'; None means 'we do not know'. Collapsing both to None made a
        throttled run look like a run of holidays."""
        import delivery_volume_fetcher as dvf

        class _Resp:
            status_code = 404

        class _Err(Exception):
            response = _Resp()

        class _Boom(Exception):
            response = None

        def fake_404(session, url, **kw):
            raise _Err("404")

        def fake_boom(session, url, **kw):
            raise _Boom("connection reset")

        orig = dvf.retry_get
        try:
            dvf.retry_get = fake_404
            assert dvf.fetch_mto(datetime.date(2026, 4, 3), None) == []
            dvf.retry_get = fake_boom
            assert dvf.fetch_mto(datetime.date(2026, 4, 3), None) is None
        finally:
            dvf.retry_get = orig
