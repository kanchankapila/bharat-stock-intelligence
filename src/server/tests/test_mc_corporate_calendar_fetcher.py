import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_corporate_calendar_fetcher as mcc


class TestParseDate:
    def test_valid_ddmmyyyy(self):
        assert mcc._parse_date("15/03/2026") == date(2026, 3, 15)

    def test_sentinel_values_return_none(self):
        assert mcc._parse_date("-") is None
        assert mcc._parse_date("NA") is None
        assert mcc._parse_date("N/A") is None
        assert mcc._parse_date("") is None
        assert mcc._parse_date(None) is None

    def test_malformed_string_returns_none_not_raise(self):
        assert mcc._parse_date("not-a-date") is None


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _FakeConn:
    """Mimics the con.execute(sql, params).fetchall() surface _refresh_historical_div
    uses -- SELECT queries return canned rows, non-SELECT (UPDATE) calls are recorded."""

    def __init__(self, select_rows):
        self._select_rows = select_rows
        self.updates = []

    def execute(self, sql, params=None):
        if sql.strip().upper().startswith("SELECT"):
            return _FakeCursor(self._select_rows)
        self.updates.append((sql, params))
        return _FakeCursor([])

    def commit(self):
        pass


class TestRefreshHistoricalDivSkipsBadDates:
    """Regression test for the fix: an unguarded date.fromisoformat() on
    corporate_actions.ex_date (a TEXT column) used to crash the whole run on the first
    malformed date. It's now guarded per-symbol and strips a time suffix before parsing."""

    def test_malformed_ex_date_is_skipped_without_raising(self):
        con = _FakeConn(select_rows=[("BADSYM", "not-a-date", 5.0)])
        updated = mcc._refresh_historical_div(con, {"BADSYM"}, date(2026, 7, 19))
        assert updated == 0
        assert con.updates == []

    def test_time_suffixed_ex_date_is_stripped_and_parsed(self):
        con = _FakeConn(select_rows=[("RELIANCE", "2026-06-01 00:00:00", 15.0)])
        updated = mcc._refresh_historical_div(con, {"RELIANCE"}, date(2026, 7, 19))
        assert updated == 1
        assert len(con.updates) == 1
        _, params = con.updates[0]
        assert params["ds"] == 48.0  # 2026-06-01 -> 2026-07-19
        assert params["la"] == 15.0

    def test_mixed_batch_skips_only_the_bad_row(self):
        con = _FakeConn(select_rows=[
            ("GOOD", "2026-07-01", 10.0),
            ("BAD", "garbage", 3.0),
        ])
        updated = mcc._refresh_historical_div(con, {"GOOD", "BAD"}, date(2026, 7, 19))
        assert updated == 1
        assert len(con.updates) == 1
