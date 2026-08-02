import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fundamentals_snapshot as fs


class _FakeCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()
        self.committed = False
        self.closed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


class TestLastTradingSessionFloor:
    """Regression test for Finding #4 (2026-07-28 full-stack audit): the
    technical_signals.pledge_chg_90d UPDATE guard was anchored to
    datetime.date.today() -- the identical date.today()-anchored CASE...ELSE NULL
    pattern already found and fixed in 6 sibling fetchers on 2026-07-25
    (trendlyne_fundamentals_fetcher.py etc), but never propagated to this file. On
    any run where "today" doesn't match an existing technical_signals row for a
    symbol (weekend/holiday run), every historical pledge_chg_90d row for that
    symbol was explicitly NULLed. Fixed by anchoring to MAX(date) FROM stock_ohlcv
    (the last completed trading session), matching the already-proven pattern."""

    def test_uses_max_stock_ohlcv_date_when_available(self, monkeypatch):
        # logical_write_floor() (as_of.py) now owns the MAX(date) FROM stock_ohlcv query --
        # extracted into the shared helper 10+ fetchers were independently hand-rolling.
        monkeypatch.setattr(fs, "logical_write_floor", lambda *a, **k: "2026-07-29")
        assert fs._last_trading_session_floor("2026-07-30") == "2026-07-29"

    def test_falls_back_to_as_of_when_stock_ohlcv_empty(self, monkeypatch):
        # logical_write_floor() itself returns the given fallback when stock_ohlcv is empty --
        # simulate that by honoring the fallback kwarg, same as the real implementation.
        monkeypatch.setattr(fs, "logical_write_floor", lambda *a, fallback=None, **k: fallback)
        assert fs._last_trading_session_floor("2026-07-30") == "2026-07-30"

    def test_falls_back_to_as_of_on_query_failure(self, monkeypatch):
        def raises(*a, **k):
            raise RuntimeError("DB unavailable")
        monkeypatch.setattr(fs, "logical_write_floor", raises)
        assert fs._last_trading_session_floor("2026-07-30") == "2026-07-30"


class TestComputeAndWritePledgeTrend:
    def test_update_guard_uses_trading_session_floor_not_as_of(self, monkeypatch):
        """The UPDATE's `date >= ?` guard threshold must be the trading-session floor
        passed in, not whatever the caller's `as_of` happens to be -- this is the
        actual bug fix: run() now computes the floor separately from `as_of` and
        passes it through, rather than reusing `as_of` (today) as the guard."""
        fake_conn = _FakeConn()
        monkeypatch.setattr(fs, "connect", lambda: fake_conn)
        monkeypatch.setattr(fs, "query_all", lambda sql: [{"symbol": "TCS", "pledge_chg_90d": 1.5}])

        fs._compute_and_write_pledge_trend(pg=True, ts_floor="2026-07-29")

        update_calls = [(sql, params) for sql, params in fake_conn.cur.executed if "pledge_chg_90d" in sql]
        assert len(update_calls) == 1
        sql, params = update_calls[0]
        assert params[0] == "2026-07-29", "guard threshold must be the passed-in trading-session floor"
        assert fake_conn.committed is True
        assert fake_conn.closed is True

    def test_no_rows_short_circuits_without_opening_connection(self, monkeypatch):
        monkeypatch.setattr(fs, "query_all", lambda sql: [])
        opened = []
        monkeypatch.setattr(fs, "connect", lambda: opened.append(True))
        result = fs._compute_and_write_pledge_trend(pg=True, ts_floor="2026-07-29")
        assert result == 0
        assert opened == []
