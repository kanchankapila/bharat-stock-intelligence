"""Live-datasource test for marketsmojo_stock_picks_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import marketsmojo_stock_picks_fetcher as msp
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response, assert_numeric_and_finite


@pytest.mark.live_datasource
class TestMarketsMojoStockPicksLiveDataSource:
    def test_real_fetch_returns_rows(self):
        by_list = msp.fetch_picks()
        assert set(by_list.keys()) == set(msp.LISTS)
        non_empty = [name for name, rows in by_list.items() if rows]
        assert_non_empty_response(non_empty, "fetch_picks() -- at least one non-empty list")
        r = next(row for rows in by_list.values() for row in rows)
        assert r.get("stockid") is not None
        assert r.get("added_date")

    def test_stored_rows_are_ml_usable(self):
        sid_map = msp.load_sid_to_symbol_map()
        assert sid_map, "need a real stockid->symbol map to resolve rows against"
        by_list = msp.fetch_picks()
        rows = []
        for list_name, raw_rows in by_list.items():
            rows.extend(r for r in (msp.parse_pick(list_name, p, sid_map) for p in raw_rows) if r is not None)
        assert rows, "no usable (resolved-symbol) pick rows found in today's live sample"

        con = sqlite3.connect(":memory:")
        msp.ensure_schema(con)
        assert msp.store(con, rows) == len(rows)

        symbol, entry_price = con.execute(
            "SELECT symbol, entry_price FROM marketsmojo_stock_picks LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        if entry_price is not None:
            assert_numeric_and_finite(entry_price, "entry_price")
