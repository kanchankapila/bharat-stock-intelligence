"""Regression tests for Finding #64 (2026-07-28 full-stack audit): three fetchers
(mc_pricefeed_fetcher.py, mc_chart_patterns_fetcher.py, nt_dashboard_fetcher.py)
copied the date.today()-anchored `date >= ? ... ELSE NULL` write guard -- the same
bug class already fixed in 6 sibling fetchers on 2026-07-25, but copied here *after*
that fix existed (the two mc_* files' docstrings literally cite mc_pricefeed_fetcher.py's
pattern). On a closed-market day these jobs still run (ml-daily-ops'
closed-day-early-batch dispatcher), date.today() matches zero technical_signals rows,
and the ELSE branch nulls every one of their columns across a symbol's entire
history. Fixed by renaming the guard parameter from `today` to `ts_floor` and having
each main() pass MAX(date) FROM stock_ohlcv (the last completed trading session)
instead of raw date.today() -- the per-day snapshot tables these fetchers also write
(mc_pricefeed_daily, mc_pattern_signals, nt_dashboard_snapshot) are untouched and
still correctly keyed on the real calendar date.

FOLLOW-UP (2026-09-01, data/model audit): the ELSE NULL branch itself was a second,
independent bug -- ts_floor advances by one trading day every run, so ELSE NULL re-nulled
every prior day's already-correct value on every subsequent run (see recurring-bugs.md).
ELSE now preserves the row's own current value instead, so the assertions below check for
the guard's presence via `CASE WHEN date >=`, not the no-longer-accurate `ELSE NULL` text.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_pricefeed_fetcher as mcp
import mc_chart_patterns_fetcher as mcc
import nt_dashboard_fetcher as ntd


class _FakeCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()

    def cursor(self):
        return self.cur

    def commit(self):
        pass


class TestMcPricefeedFetcherFloorParam:
    def test_guard_threshold_is_the_passed_floor_not_calendar_today(self):
        con = _FakeConn()
        mcp.backfill_technical_signals("SYM", "2026-07-29", {"cagr_3y": 12.0}, con)
        sql, params = con.cur.executed[0]
        assert "CASE WHEN date >=" in sql
        # every guard-threshold slot in the params tuple must be the floor we passed in
        assert params[0] == "2026-07-29"
        assert params.count("2026-07-29") >= 15  # one per CASE WHEN clause


class TestMcChartPatternsFetcherFloorParam:
    def test_guard_threshold_is_the_passed_floor_not_calendar_today(self):
        con = _FakeConn()
        mcc.backfill_technical_signals("SYM", "2026-07-29", {"bull_count": 1}, con)
        sql, params = con.cur.executed[0]
        assert "CASE WHEN date >=" in sql
        assert params[0] == "2026-07-29"


class TestNtDashboardFetcherFloorParam:
    def test_guard_threshold_is_the_passed_floor_not_calendar_today(self):
        con = _FakeConn()
        ntd.backfill_technical_signals("2026-07-29", {"symbol": "SYM", "pcr": 0.9}, con)
        sql, params = con.cur.executed[0]
        assert "CASE WHEN date >=" in sql
        assert params[0] == "2026-07-29"


class TestMainFunctionsComputeFloorFromStockOhlcv:
    """main() in each file must derive ts_floor from MAX(date) FROM stock_ohlcv via
    query_scalar, not reuse date.today() -- this is the actual fix; the functions
    above only prove the plumbing carries whatever floor they're given."""

    def test_mc_pricefeed_imports_logical_write_floor(self):
        assert hasattr(mcp, "logical_write_floor")

    def test_mc_pricefeed_main_source_uses_logical_write_floor_for_ts_floor(self):
        import inspect
        src = inspect.getsource(mcp.main)
        assert "ts_floor" in src
        assert "logical_write_floor" in src

    def test_mc_chart_patterns_main_source_uses_logical_write_floor_for_ts_floor(self):
        import inspect
        assert hasattr(mcc, "logical_write_floor")
        src = inspect.getsource(mcc.main)
        assert "ts_floor" in src
        assert "logical_write_floor" in src

    def test_nt_dashboard_main_source_uses_logical_write_floor_for_ts_floor(self):
        import inspect
        assert hasattr(ntd, "logical_write_floor")
        src = inspect.getsource(ntd.main)
        assert "ts_floor" in src
        assert "logical_write_floor" in src
