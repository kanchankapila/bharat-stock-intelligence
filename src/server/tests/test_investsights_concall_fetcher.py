"""Regression tests for investsights_concall_fetcher.py.

Fixture shaped from a real payload captured live on 2026-08-06.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_concall_fetcher as cc

UNIVERSE = {"RBA", "TATASTEEL"}

REAL_ITEM = {
    "symbol": "RBA", "company_name": "Restaurant Brands Asia Limited",
    "quarter": "Q1", "fiscal_year": "FY27",
    "key_takeaway": "The single most important signal from this concall is the "
                     "step-change in India's operating leverage.",
    "tone_assessment": "Overall tone: Confident, particularly on India.",
    "transcript_source": "finedge",
    "generated_at": "2026-08-06T16:12:24.785840+00:00",
    "announcement_date": "2026-08-06T12:55:43+00:00",
}


class TestParseItem:
    def test_maps_a_real_item(self):
        r = cc.parse_item(REAL_ITEM, UNIVERSE)
        assert r["symbol"] == "RBA"
        assert r["quarter"] == "Q1"
        assert r["fiscal_year"] == "FY27"
        assert r["announcement_date"] == "2026-08-06"   # ISO timestamp truncated to a date
        assert r["key_takeaway"].startswith("The single most important")
        assert r["source"] == "investsights"

    def test_id_is_deterministic_composite_not_a_raw_upstream_field(self):
        """The upstream payload carries no id/_id (module docstring) -- the key must be
        derived from (symbol, fiscal_year, quarter), and must be stable across repeated
        parses of the same logical item."""
        r1 = cc.parse_item(REAL_ITEM, UNIVERSE)
        r2 = cc.parse_item(dict(REAL_ITEM), UNIVERSE)
        assert r1["id"] == r2["id"] == "is:RBA:FY27:Q1"

    def test_different_quarters_produce_different_ids(self):
        r_q1 = cc.parse_item(REAL_ITEM, UNIVERSE)
        r_q2 = cc.parse_item({**REAL_ITEM, "quarter": "Q2"}, UNIVERSE)
        assert r_q1["id"] != r_q2["id"]

    def test_generated_at_is_kept_separate_from_announcement_date(self):
        """generated_at (when the AI wrote the summary) must never be used as the as-of join
        key -- announcement_date (real disclosure timestamp) is the only one a consumer
        should join on (module docstring, AS-OF DISCIPLINE)."""
        r = cc.parse_item(REAL_ITEM, UNIVERSE)
        assert r["announcement_date"] != r["generated_at"]
        assert r["announcement_date"] == "2026-08-06"
        assert r["generated_at"].startswith("2026-08-06T16:12:24")

    @pytest.mark.parametrize("bad", [
        {**REAL_ITEM, "symbol": ""},
        {**REAL_ITEM, "symbol": "NOTINUNIVERSE"},
        {**REAL_ITEM, "quarter": ""},
        {**REAL_ITEM, "fiscal_year": ""},
        {**REAL_ITEM, "announcement_date": ""},
    ])
    def test_unusable_items_are_dropped(self, bad):
        assert cc.parse_item(bad, UNIVERSE) is None


class TestSchemaAndStorage:
    def test_ensure_schema_and_store_round_trip(self):
        con = pg_memory_conn()
        cc.ensure_schema(con)
        row = cc.parse_item(REAL_ITEM, UNIVERSE)
        assert cc.store(con, [row]) == 1
        symbol, quarter, tone = con.execute(
            "SELECT symbol, quarter, tone_assessment FROM concall_takeaways LIMIT 1"
        ).fetchone()
        assert symbol == "RBA"
        assert quarter == "Q1"
        assert "Confident" in tone

    def test_upsert_is_idempotent_and_updates_on_re_fetch(self):
        """A re-generated summary for the same (symbol, fiscal_year, quarter) must UPDATE the
        existing row, not create a duplicate."""
        con = pg_memory_conn()
        cc.ensure_schema(con)
        row1 = cc.parse_item(REAL_ITEM, UNIVERSE)
        assert cc.store(con, [row1]) == 1
        row2 = cc.parse_item({**REAL_ITEM, "key_takeaway": "Revised takeaway."}, UNIVERSE)
        assert cc.store(con, [row2]) == 1
        count, takeaway = con.execute(
            "SELECT COUNT(*), MAX(key_takeaway) FROM concall_takeaways"
        ).fetchone()
        assert count == 1
        assert takeaway == "Revised takeaway."

    def test_store_empty_list_is_a_noop(self):
        con = pg_memory_conn()
        cc.ensure_schema(con)
        assert cc.store(con, []) == 0
