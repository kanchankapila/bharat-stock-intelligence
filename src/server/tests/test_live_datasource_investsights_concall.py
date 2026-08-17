"""Live-datasource test for investsights_concall_fetcher.py
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

import investsights_concall_fetcher as cc
from live_datasource_helpers import assert_non_empty_response


def _session():
    s = requests.Session()
    s.headers.update(cc.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsConcallLiveDataSource:
    def test_real_fetch_returns_dated_items_with_no_upstream_id(self):
        items = cc.fetch_recent(_session(), limit=10)
        assert_non_empty_response(items, "fetch_recent()")
        item = items[0]
        assert "id" not in item and "_id" not in item, (
            "upstream now carries an id -- reconsider the deterministic composite key in "
            "parse_item(), this was a documented assumption, not a permanent fact"
        )
        assert item.get("symbol"), "expected a real symbol"
        assert item.get("quarter") and item.get("fiscal_year")
        # raw field is a full ISO timestamp; parse_item() truncates it to a date (tested below)
        ann = item.get("announcement_date", "")
        assert len(ann) >= 10 and ann[4] == "-" and ann[7] == "-", f"not ISO-prefixed: {ann!r}"

    def test_stored_rows_are_ml_usable(self):
        universe = cc.load_nse_universe()
        assert universe
        items = cc.fetch_recent(_session(), limit=20)
        rows = [r for r in (cc.parse_item(i, universe) for i in items) if r is not None]
        assert rows, "no usable (NSE-tickered) concall rows in the recent window"

        con = pg_memory_conn()
        cc.ensure_schema(con)
        assert cc.store(con, rows) == len(rows)

        symbol, quarter, fy, ann_date, key_takeaway = con.execute(
            "SELECT symbol, quarter, fiscal_year, announcement_date, key_takeaway "
            "FROM concall_takeaways LIMIT 1"
        ).fetchone()
        assert symbol in universe
        assert quarter and fy
        assert len(ann_date) == 10 and ann_date[4] == "-"
        assert key_takeaway and len(key_takeaway) > 20, "expected real prose, not a stub"

    def test_id_is_deterministic_and_stable_across_repeated_fetches(self):
        """The same (symbol, fiscal_year, quarter) fetched twice must produce the same id, so
        a re-run upserts the row instead of duplicating it."""
        universe = cc.load_nse_universe()
        raw = {"symbol": next(iter(universe)), "quarter": "Q1", "fiscal_year": "FY27",
               "announcement_date": "2026-08-01", "generated_at": "2026-08-01T10:00:00Z",
               "key_takeaway": "x", "tone_assessment": "y", "transcript_source": "z",
               "company_name": "Test Co"}
        row1 = cc.parse_item(raw, universe)
        row2 = cc.parse_item(dict(raw), universe)
        assert row1["id"] == row2["id"]
