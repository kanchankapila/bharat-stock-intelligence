"""Live-datasource test for investsights_factor_scores_fetcher.py
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

import investsights_factor_scores_fetcher as fs
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable


def _session():
    s = requests.Session()
    s.headers.update(fs.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsFactorScoresLiveDataSource:
    def test_real_page_fetch_is_capped_at_100(self):
        """Live-confirmed 2026-08-13: `limit` is silently capped server-side at 100
        regardless of the requested value -- this pins that quirk so pagination logic
        doesn't silently break if the provider ever raises the cap."""
        payload = fs.fetch_page(_session(), offset=0)
        assert_non_empty_response(payload.get("data"), "advanced-screener/query page")
        assert payload.get("count") <= 100
        assert payload.get("total", 0) > 100, "expected a universe larger than one page"

    def test_pagination_offset_advances_without_duplicates(self):
        session = _session()
        page0 = fs.fetch_page(session, offset=0)["data"]
        page1 = fs.fetch_page(session, offset=len(page0))["data"]
        symbols0 = {r["symbol"] for r in page0}
        symbols1 = {r["symbol"] for r in page1}
        assert not (symbols0 & symbols1), "consecutive pages must not overlap"

    def test_stored_row_is_ml_usable(self):
        session = _session()
        raw_rows = fs.fetch_page(session, offset=0)["data"]
        assert raw_rows
        parsed = [fs.parse_row(r, "2026-08-13") for r in raw_rows]
        parsed = [r for r in parsed if r]
        assert parsed

        con = pg_memory_conn()
        fs.ensure_schema(con)
        assert fs.store_rows(con, parsed) == len(parsed)

        # pe_ratio/roe can be legitimately NULL (loss-making names) -- pick a row where the
        # provider actually populated them, rather than assert against whichever row landed
        # first, which would flake against real-world nulls.
        cur = con.execute(
            "SELECT symbol, pe_ratio, roe, market_cap FROM investsights_factor_scores "
            "WHERE pe_ratio IS NOT NULL AND roe IS NOT NULL LIMIT 1"
        )
        row = cur.fetchone()
        assert row, "no fetched row had both pe_ratio and roe populated"
        cols = [d[0] for d in cur.description]
        stored = dict(zip(cols, row))
        assert_stored_row_ml_usable(
            stored, numeric_cols=["pe_ratio", "roe", "market_cap"],
            ticker_cols=["symbol"], context="investsights_factor_scores",
        )
