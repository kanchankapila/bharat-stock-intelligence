"""Live-datasource test for investsights_sector_intel_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_sector_intel_fetcher as si
from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite


def _session():
    s = requests.Session()
    s.headers.update(si.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsSectorIntelLiveDataSource:
    def test_real_rrg_fetch_has_dated_sector_trails(self):
        payload = si.fetch_sector_rrg(_session(), weeks=12)
        sectors = payload.get("sectors")
        assert_non_empty_response(sectors, "sector-rrg.sectors")
        first = sectors[0]
        trail = first.get("trail")
        assert_non_empty_response(trail, "sector-rrg.sectors[0].trail")
        pt = trail[-1]
        assert len(pt.get("week_date", "")) == 10, f"week_date not ISO: {pt.get('week_date')!r}"
        assert pt.get("quadrant") in si.VALID_QUADRANTS, f"unexpected quadrant: {pt.get('quadrant')!r}"
        assert_numeric_and_finite(pt.get("rs_ratio"), "rs_ratio")

    def test_real_correlation_matrix_is_square_and_bounded(self):
        payload = si.fetch_sector_correlation(_session(), period=60)
        sectors = payload.get("sectors")
        assert_non_empty_response(sectors, "sector-correlation.sectors")
        matrix = payload.get("matrix") or []
        assert len(matrix) == len(sectors), "matrix row count must match sector count"
        for row in matrix:
            assert len(row) == len(sectors), "matrix must be square"
        # diagonal is always self-correlation
        for i in range(len(sectors)):
            assert abs(float(matrix[i][i]) - 1.0) < 0.01, f"diagonal[{i}] should be ~1.0"
        # off-diagonal correlations are bounded [-1, 1]
        for row in matrix:
            for v in row:
                assert -1.0 <= float(v) <= 1.0, f"correlation out of bounds: {v}"

    def test_diversifiers_and_redundant_are_disjoint_and_directionally_correct(self):
        payload = si.fetch_sector_correlation(_session(), period=60)
        div = payload.get("diversifiers") or []
        red = payload.get("redundant") or []
        assert_non_empty_response(div, "diversifiers")
        assert_non_empty_response(red, "redundant")
        for d in div:
            assert d["correlation"] < 0.5, f"a 'diversifier' pair should be low-correlation: {d}"
        for r in red:
            assert r["correlation"] > 0.5, f"a 'redundant' pair should be high-correlation: {r}"

    def test_stored_rows_are_ml_usable(self):
        session = _session()
        rrg_rows = si.parse_rrg_rows(si.fetch_sector_rrg(session, weeks=12), weeks=12)
        corr_payload = si.fetch_sector_correlation(session, period=60)
        pair_rows = si.parse_correlation_pairs(corr_payload)
        stats_rows = si.parse_stats_rows(corr_payload)
        summary_row = si.parse_summary_row(corr_payload)
        assert rrg_rows and pair_rows and stats_rows and summary_row

        con = pg_memory_conn()
        si.ensure_schema(con)
        assert si.store_rrg(con, rrg_rows) == len(rrg_rows)
        assert si.store_pairs(con, pair_rows) == len(pair_rows)
        assert si.store_stats(con, stats_rows) == len(stats_rows)
        assert si.store_summary(con, summary_row) == 1

        sector, week_date, rs_ratio = con.execute(
            "SELECT sector, week_date, rs_ratio FROM sector_rrg_history LIMIT 1"
        ).fetchone()
        assert sector and len(week_date) == 10
        assert_numeric_and_finite(rs_ratio, "rs_ratio")

        a, b, corr = con.execute(
            "SELECT sector_a, sector_b, correlation FROM sector_correlation_pairs LIMIT 1"
        ).fetchone()
        assert a != b, "a sector should never be paired with itself"
        assert_numeric_and_finite(corr, "correlation")

    def test_no_diagonal_or_duplicate_pairs_stored(self):
        """The upper-triangle-only storage rule (module docstring) must hold on real data --
        a self-pair or a (b, a) duplicate of an already-stored (a, b) would double the row
        count for zero new information."""
        payload = si.fetch_sector_correlation(_session(), period=60)
        pairs = si.parse_correlation_pairs(payload)
        seen = set()
        for p in pairs:
            assert p["sector_a"] != p["sector_b"], f"self-pair stored: {p}"
            key = frozenset((p["sector_a"], p["sector_b"]))
            assert key not in seen, f"duplicate pair stored: {p}"
            seen.add(key)
