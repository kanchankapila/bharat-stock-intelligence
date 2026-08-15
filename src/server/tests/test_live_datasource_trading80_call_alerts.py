"""Live-datasource test for trading80_call_alerts_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import trading80_call_alerts_fetcher as tca
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response, assert_numeric_and_finite


@pytest.mark.live_datasource
class TestTrading80CallAlertsLiveDataSource:
    def test_real_fetch_returns_rows(self):
        by_list = tca.fetch_call_alerts()
        assert set(by_list.keys()) == set(tca.LISTS)
        non_empty = [name for name, rows in by_list.items() if rows]
        assert_non_empty_response(non_empty, "fetch_call_alerts() -- at least one non-empty list")
        r = next(row for rows in by_list.values() for row in rows)
        assert r.get("stockid") is not None
        assert r.get("id")

    def test_stored_rows_are_ml_usable(self):
        sid_map = tca.load_sid_to_symbol_map()
        assert sid_map, "need a real stockid->symbol map to resolve rows against"
        by_list = tca.fetch_call_alerts()
        rows = []
        for list_name, raw_rows in by_list.items():
            rows.extend(r for r in (tca.parse_call(list_name, c, sid_map) for c in raw_rows) if r is not None)
        assert rows, "no usable (resolved-symbol) call rows found in today's live sample"

        con = sqlite3.connect(":memory:")
        tca.ensure_schema(con)
        assert tca.store(con, rows) == len(rows)

        symbol, target_price = con.execute(
            "SELECT symbol, target_price FROM trading80_call_alerts LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        if target_price is not None:
            assert_numeric_and_finite(target_price, "target_price")
