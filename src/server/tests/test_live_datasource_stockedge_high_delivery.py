"""Live-datasource test for stockedge_high_delivery_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import stockedge_high_delivery_fetcher as sef
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response, assert_numeric_and_finite


@pytest.mark.live_datasource
class TestStockEdgeHighDeliveryLiveDataSource:
    def test_real_fetch_returns_dated_rows(self):
        rows = sef.fetch_alerts()
        assert_non_empty_response(rows, "fetch_alerts()")
        r = rows[0]
        assert r.get("Symb"), "expected a real ticker on every row"
        assert len(r.get("Date", "")) >= 10, f"Date not ISO-shaped: {r.get('Date')!r}"
        assert r.get("ID") is not None

    def test_stored_rows_are_ml_usable(self):
        universe = sef.load_nse_universe()
        assert universe, "need a real nse_stocks universe to resolve symbols against"
        raw = sef.fetch_alerts()
        rows = [r for r in (sef.parse_alert(a, universe) for a in raw) if r is not None]
        assert rows, "no usable (NSE-tickered) alert rows found in today's live sample"

        con = pg_memory_conn()
        sef.ensure_schema(con)
        assert sef.store(con, rows) == len(rows)

        symbol, times_dq = con.execute(
            "SELECT symbol, times_delivery_qty FROM stockedge_high_delivery_alerts LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        if times_dq is not None:
            assert_numeric_and_finite(times_dq, "times_delivery_qty")
