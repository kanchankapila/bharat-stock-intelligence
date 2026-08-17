"""Regression tests for investsights_sector_intel_fetcher.py.

Fixtures shaped from real payloads captured live on 2026-08-06.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_sector_intel_fetcher as si


RRG_PAYLOAD = {
    "success": True, "data_source": "calculated", "latest_date": "2026-08-06", "weeks": 12,
    "sectors": [
        {"sector": "Airlines", "trail": [
            {"week_date": "2026-07-27", "rs_ratio": 118.55, "rs_momentum": 113.88,
             "sector_return": -2.21, "stocks_count": 1, "quadrant": "Leading"},
            {"week_date": "2026-08-06", "rs_ratio": 113.98, "rs_momentum": 98.85,
             "sector_return": 1.15, "stocks_count": 1, "quadrant": "Weakening"},
        ]},
        {"sector": "Banking", "trail": [
            {"week_date": "2026-08-06", "rs_ratio": 101.2, "rs_momentum": 104.1,
             "sector_return": 0.8, "stocks_count": 12, "quadrant": "Improving"},
        ]},
    ],
}

CORR_PAYLOAD = {
    "success": True, "data_date": "2026-08-06", "period_days": 61,
    "sectors": ["Airlines", "Banking", "IT & Technology"],
    "matrix": [
        [1.0, 0.79, 0.31],
        [0.79, 1.0, 0.12],
        [0.31, 0.12, 1.0],
    ],
    "sector_stats": [
        {"name": "Airlines", "avg_daily_return": 0.3079, "volatility": 1.9634,
         "total_return": 18.89, "data_points": 60},
        {"name": "Banking", "avg_daily_return": 0.1046, "volatility": 0.9227,
         "total_return": 6.2, "data_points": 60},
        {"name": "IT & Technology", "avg_daily_return": 0.05, "volatility": 1.1,
         "total_return": 3.0, "data_points": 60},
    ],
    "diversifiers": [{"sector_a": "Banking", "sector_b": "IT & Technology", "correlation": 0.12}],
    "redundant": [{"sector_a": "Airlines", "sector_b": "Banking", "correlation": 0.79}],
    "breadth": {"avg_pairwise_correlation": 0.4067, "pct_pairs_above_0_7": 33.3, "total_pairs": 3},
    "takeaway": "Banking and Airlines move together; IT is the diversifier.",
}


class TestParseRrgRows:
    def test_flattens_sector_trails_to_one_row_per_week(self):
        rows = si.parse_rrg_rows(RRG_PAYLOAD, weeks=12)
        assert len(rows) == 3
        assert {(r["sector"], r["week_date"]) for r in rows} == {
            ("Airlines", "2026-07-27"), ("Airlines", "2026-08-06"), ("Banking", "2026-08-06"),
        }

    def test_unrecognized_quadrant_label_becomes_none_not_a_guess(self):
        payload = {"sectors": [{"sector": "X", "trail": [
            {"week_date": "2026-08-06", "quadrant": "Something New"}
        ]}]}
        rows = si.parse_rrg_rows(payload, weeks=12)
        assert rows[0]["quadrant"] is None

    def test_missing_week_date_is_skipped(self):
        payload = {"sectors": [{"sector": "X", "trail": [{"week_date": ""}]}]}
        assert si.parse_rrg_rows(payload, weeks=12) == []


class TestParseCorrelationPairs:
    def test_stores_upper_triangle_only(self):
        pairs = si.parse_correlation_pairs(CORR_PAYLOAD)
        # 3 sectors -> C(3,2) = 3 unique pairs, never the diagonal, never a duplicate direction
        assert len(pairs) == 3
        seen = {frozenset((p["sector_a"], p["sector_b"])) for p in pairs}
        assert len(seen) == 3
        assert all(p["sector_a"] != p["sector_b"] for p in pairs)

    def test_tags_diversifier_and_redundant_regardless_of_order_in_source_list(self):
        pairs = si.parse_correlation_pairs(CORR_PAYLOAD)
        by_pair = {frozenset((p["sector_a"], p["sector_b"])): p for p in pairs}
        assert by_pair[frozenset(("Banking", "IT & Technology"))]["pair_type"] == "diversifier"
        assert by_pair[frozenset(("Airlines", "Banking"))]["pair_type"] == "redundant"

    def test_untagged_pair_has_null_pair_type(self):
        pairs = si.parse_correlation_pairs(CORR_PAYLOAD)
        by_pair = {frozenset((p["sector_a"], p["sector_b"])): p for p in pairs}
        assert by_pair[frozenset(("Airlines", "IT & Technology"))]["pair_type"] is None

    def test_mismatched_matrix_dimensions_returns_no_rows_rather_than_crash(self):
        bad = {**CORR_PAYLOAD, "matrix": [[1.0]]}   # 1x1 matrix but 3 sectors
        assert si.parse_correlation_pairs(bad) == []

    def test_missing_data_date_returns_no_rows(self):
        bad = {**CORR_PAYLOAD, "data_date": ""}
        assert si.parse_correlation_pairs(bad) == []


class TestParseStatsAndSummary:
    def test_stats_rows_one_per_sector(self):
        rows = si.parse_stats_rows(CORR_PAYLOAD)
        assert len(rows) == 3
        assert {r["sector"] for r in rows} == {"Airlines", "Banking", "IT & Technology"}

    def test_summary_row_carries_breadth_and_takeaway(self):
        row = si.parse_summary_row(CORR_PAYLOAD)
        assert row["data_date"] == "2026-08-06"
        assert row["avg_pairwise_correlation"] == pytest.approx(0.4067)
        assert row["total_pairs"] == 3
        assert "Banking" in row["takeaway"]

    def test_summary_row_none_when_no_data_date(self):
        assert si.parse_summary_row({**CORR_PAYLOAD, "data_date": ""}) is None


class TestSchemaAndStorage:
    def test_ensure_schema_creates_all_four_tables(self):
        con = pg_memory_conn()
        si.ensure_schema(con)
        tables = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert {"sector_rrg_history", "sector_correlation_pairs",
                "sector_correlation_stats", "sector_correlation_summary"} <= tables

    def test_upsert_is_idempotent(self):
        con = pg_memory_conn()
        si.ensure_schema(con)
        rows = si.parse_rrg_rows(RRG_PAYLOAD, weeks=12)
        assert si.store_rrg(con, rows) == 3
        # re-storing the identical rows must not create duplicates (ON CONFLICT DO UPDATE)
        assert si.store_rrg(con, rows) == 3
        count = con.execute("SELECT COUNT(*) FROM sector_rrg_history").fetchone()[0]
        assert count == 3

    def test_full_pipeline_end_to_end(self):
        con = pg_memory_conn()
        si.ensure_schema(con)
        rrg_rows = si.parse_rrg_rows(RRG_PAYLOAD, weeks=12)
        pair_rows = si.parse_correlation_pairs(CORR_PAYLOAD)
        stats_rows = si.parse_stats_rows(CORR_PAYLOAD)
        summary_row = si.parse_summary_row(CORR_PAYLOAD)
        assert si.store_rrg(con, rrg_rows) == 3
        assert si.store_pairs(con, pair_rows) == 3
        assert si.store_stats(con, stats_rows) == 3
        assert si.store_summary(con, summary_row) == 1
