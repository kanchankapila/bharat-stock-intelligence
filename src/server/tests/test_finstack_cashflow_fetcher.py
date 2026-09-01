"""
Tests for finstack_cashflow_fetcher.py — the FinStack-MCP quarterly cash-flow ingest.

Pure-function tests (parse_quarterly_cashflow) need no DB or network. The DB test pins
weekly-cadence idempotency against real Postgres via pg_conn (auto-skips unreachable).
The MCP client itself is exercised live in scratch probes, not here — this suite must
stay hermetic per CLAUDE.md's unit-lane rules.
"""

import importlib
import os
import sys
import uuid

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import finstack_cashflow_fetcher as fcf


def _envelope(periods: list[dict], currency: str = "INR") -> dict:
    return {"symbol": "TEST", "type": "quarterly", "periods": len(periods),
            "currency": currency, "data": periods, "timestamp": "2026-09-01T00:00:00"}


class TestParseQuarterlyCashflow:
    def test_maps_core_lines_and_periods(self):
        env = _envelope([
            {"period": "2026-06-30", "operating_cash_flow": 1036000000.123,
             "investing_cash_flow": 158000000.0, "financing_cash_flow": -1258000000.0,
             "capital_expenditure": -81000000.0, "free_cash_flow": 955000000.0,
             "depreciation_amortization": 99999.0},
        ])
        rows = fcf.parse_quarterly_cashflow(env)
        assert len(rows) == 1
        r = rows[0]
        assert r["period_end"] == "2026-06-30"
        assert r["ocf"] == 1036000000.12          # rounded to 2dp
        assert r["cfi"] == 158000000.0
        assert r["cff"] == -1258000000.0
        assert r["capex"] == -81000000.0
        assert r["fcf"] == 955000000.0
        assert r["currency"] == "INR"

    def test_error_envelope_yields_no_rows(self):
        assert fcf.parse_quarterly_cashflow({"error": True, "message": "No cash flow data"}) == []

    def test_none_and_garbage_yield_no_rows(self):
        assert fcf.parse_quarterly_cashflow(None) == []
        assert fcf.parse_quarterly_cashflow([]) == []
        assert fcf.parse_quarterly_cashflow("junk") == []

    def test_periods_missing_period_or_all_null_are_dropped(self):
        env = _envelope([
            {"operating_cash_flow": 1.0},                      # no period
            {"period": "2026-03-31"},                          # all figures null
            {"period": "2025-12-31", "operating_cash_flow": None,
             "investing_cash_flow": -5.0},                     # kept: one figure
        ])
        rows = fcf.parse_quarterly_cashflow(env)
        assert [r["period_end"] for r in rows] == ["2025-12-31"]
        assert rows[0]["cfi"] == -5.0
        assert rows[0]["ocf"] is None

    def test_currency_is_carried_per_row(self):
        rows = fcf.parse_quarterly_cashflow(_envelope(
            [{"period": "2026-06-30", "free_cash_flow": 955.0}], currency="USD"))
        assert rows[0]["currency"] == "USD"


class TestUpsertQuarterlyCashflow:
    def test_upsert_is_idempotent_and_refreshes(self, pg_conn):
        fcf.ensure_schema(pg_conn)
        pg_conn.execute("DELETE FROM finstack_cashflow_history")
        pg_conn.commit()

        rows = fcf.parse_quarterly_cashflow(_envelope([
            {"period": "2026-06-30", "operating_cash_flow": 1036.0, "free_cash_flow": 955.0},
            {"period": "2026-03-31", "operating_cash_flow": 937.0, "free_cash_flow": 833.0},
        ]))
        fcf.upsert_cashflow("INFY", rows, pg_conn)
        fcf.upsert_cashflow("INFY", rows, pg_conn)  # second weekly run: no duplicates

        cur = pg_conn.execute(
            "SELECT period_end, ocf, fcf, currency FROM finstack_cashflow_history "
            "WHERE symbol = 'INFY' ORDER BY period_end DESC")
        assert cur.fetchall() == [
            ("2026-06-30", 1036.0, 955.0, "INR"),
            ("2026-03-31", 937.0, 833.0, "INR"),
        ]

        # restatement: same PK, new figures -> refreshed in place
        rows[0]["ocf"] = 1100.0
        fcf.upsert_cashflow("INFY", rows, pg_conn)
        cur = pg_conn.execute(
            "SELECT ocf FROM finstack_cashflow_history WHERE symbol='INFY' AND period_end='2026-06-30'")
        assert cur.fetchall() == [(1100.0,)]

    def test_empty_rows_is_a_noop(self, pg_conn):
        fcf.upsert_cashflow("INFY", [], pg_conn)  # must not raise
