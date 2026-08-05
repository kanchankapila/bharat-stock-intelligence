"""Unit tests for feature_coverage_gate.py -- the pre-flight coverage check that must be run
before wiring a new column into a unified_ranker.py engine (see that module's own docstring,
and test_unified_ranker_regime.py::TestEngineCountIsPinned for the enforcement half).

Fast, DB-free: a fake connection object stands in for a real psycopg2/sqlite connection so
these run on every test invocation, not just RUN_LIVE_DATASOURCE_TESTS=1 (the real live query
correctness is covered separately by manual runs against production, matching this repo's
convention of keeping cheap logic tests unconditional and only gating genuinely
network-dependent tests).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import feature_coverage_gate as fcg


class _FakeCursorResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeConn:
    """Records every SQL string it was asked to run and returns a canned result keyed off a
    substring match -- enough to drive full_row_count_date()/column_coverage() without a
    real database, while still exercising the exact query shapes those functions build."""

    def __init__(self, busiest_date_rows, total_rows, per_column_counts):
        self.busiest_date_rows = busiest_date_rows
        self.total_rows = total_rows
        self.per_column_counts = per_column_counts
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if "GROUP BY date::text" in sql:
            return _FakeCursorResult(self.busiest_date_rows)
        if sql.strip().startswith("SELECT COUNT(*)"):
            return _FakeCursorResult([(self.total_rows,)])
        if sql.strip().startswith('SELECT COUNT("'):
            col = sql.split('COUNT("')[1].split('"')[0]
            if col not in self.per_column_counts:
                raise Exception(f'column "{col}" does not exist')
            return _FakeCursorResult([(self.per_column_counts[col],)])
        raise AssertionError(f"unexpected SQL in fake conn: {sql}")


class TestFullRowCountDate:
    def test_picks_the_busiest_date_not_the_most_recent(self):
        # Deliberately out of date order -- the busiest date (2000 rows) is NOT the most
        # recent one (200 rows, a partial-day trap like the real 2026-07-31 incident).
        conn = _FakeConn(
            busiest_date_rows=[("2026-07-27", 2000), ("2026-07-31", 200)],
            total_rows=0, per_column_counts={},
        )
        assert fcg.full_row_count_date(conn) == "2026-07-27"

    def test_returns_none_when_table_is_empty(self):
        conn = _FakeConn(busiest_date_rows=[], total_rows=0, per_column_counts={})
        assert fcg.full_row_count_date(conn) is None


class TestColumnCoverage:
    def test_reports_coverage_fraction_per_column(self):
        conn = _FakeConn(
            busiest_date_rows=[], total_rows=2188,
            per_column_counts={"roce": 1644, "mc_cagr_3y": 0},
        )
        report = fcg.column_coverage(conn, ["roce", "mc_cagr_3y"], "2026-07-27")
        assert report["roce"]["coverage"] == pytest.approx(1644 / 2188)
        assert report["mc_cagr_3y"]["coverage"] == 0.0

    def test_missing_column_reports_error_not_a_crash(self):
        conn = _FakeConn(busiest_date_rows=[], total_rows=100, per_column_counts={})
        report = fcg.column_coverage(conn, ["not_a_real_column"], "2026-07-27")
        assert report["not_a_real_column"]["coverage"] is None
        assert "error" in report["not_a_real_column"]

    def test_zero_total_rows_reports_zero_coverage_not_a_division_error(self):
        conn = _FakeConn(busiest_date_rows=[], total_rows=0, per_column_counts={"roce": 0})
        report = fcg.column_coverage(conn, ["roce"], "2026-08-01")
        assert report["roce"]["coverage"] == 0.0


class TestAssertColumnsReady:
    def test_passes_when_every_column_clears_the_floor(self):
        conn = _FakeConn(
            busiest_date_rows=[("2026-07-27", 2188)], total_rows=2188,
            per_column_counts={"roce": 1644, "mf_flow_rank": 999},
        )
        report = fcg.assert_columns_ready(conn, ["roce", "mf_flow_rank"], min_coverage=0.05)
        assert set(report) == {"roce", "mf_flow_rank"}

    def test_raises_naming_every_column_below_the_floor(self):
        conn = _FakeConn(
            busiest_date_rows=[("2026-07-27", 2188)], total_rows=2188,
            per_column_counts={"roce": 1644, "mc_cagr_3y": 0, "insider_buy_pct_90d": 4},
        )
        with pytest.raises(AssertionError) as exc_info:
            fcg.assert_columns_ready(
                conn, ["roce", "mc_cagr_3y", "insider_buy_pct_90d"], min_coverage=0.05,
            )
        msg = str(exc_info.value)
        assert "mc_cagr_3y" in msg
        assert "insider_buy_pct_90d" in msg
        # roce clears the floor -- it must NOT be listed as a failure.
        assert "roce:" not in msg

    def test_raises_on_missing_column_rather_than_silently_passing(self):
        conn = _FakeConn(
            busiest_date_rows=[("2026-07-27", 2188)], total_rows=2188, per_column_counts={},
        )
        with pytest.raises(AssertionError, match="typo_column"):
            fcg.assert_columns_ready(conn, ["typo_column"])

    def test_raises_when_table_is_empty_rather_than_measuring_nothing(self):
        conn = _FakeConn(busiest_date_rows=[], total_rows=0, per_column_counts={})
        with pytest.raises(AssertionError, match="no rows"):
            fcg.assert_columns_ready(conn, ["roce"])

    def test_explicit_probe_date_bypasses_auto_resolution(self):
        conn = _FakeConn(
            busiest_date_rows=[("2026-07-27", 2188)],  # would be picked if NOT overridden
            total_rows=100, per_column_counts={"roce": 90},
        )
        fcg.assert_columns_ready(conn, ["roce"], probe_date="2026-08-01")
        # Confirm the explicit date, not the busiest-date query's result, drove the COUNT call.
        count_calls = [sql for sql, params in conn.executed if 'SELECT COUNT("roce"' in sql]
        assert count_calls
        param_calls = [params for sql, params in conn.executed if 'SELECT COUNT("roce"' in sql]
        assert param_calls[0] == ("2026-08-01",)
