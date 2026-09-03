"""
live_datasource test for finstack_cashflow_fetcher.py (see .claude/rules/data-sources.md
"Adding a New Data Source"). Landed 2026-09-01 with neither mandatory artifact this file
and the freshness check together close (data-coverage-audit, 2026-09-03).

REAL_SYMBOL is INFY, not RELIANCE -- the fetcher's own module docstring records that
finstack's cash_flow tool (a thin wrapper over yfinance's quarterly_cashflow) has no
coverage for RELIANCE (returns the {"error": true} envelope) but does for INFY (4
quarters, reported in USD). Using RELIANCE here would make this test flap on vendor
coverage, not on a real regression.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
from mcp_client import McpStdioClient  # noqa: E402
import finstack_cashflow_fetcher as fcf  # noqa: E402
from live_datasource_helpers import (  # noqa: E402
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_stored_row_ml_usable,
)

REAL_SYMBOL = "INFY"


@pytest.mark.live_datasource
class TestFinstackCashflowLiveDataSource:
    def test_real_stock_returns_multi_quarter_cashflow(self):
        """Step 1-3: hit the real FinStack MCP server via the fetcher's own fetch_symbol(),
        parsed by the fetcher's own parse_quarterly_cashflow() (called internally), and
        assert it returns a real multi-quarter panel, not a stub/one-off value."""
        with McpStdioClient(fcf.DEFAULT_SERVER_CMD) as client:
            rows = fcf.fetch_symbol(client, REAL_SYMBOL)
        assert_non_empty_response(rows, f"fetch_symbol({REAL_SYMBOL})")
        assert len(rows) >= 2, (
            f"expected a multi-quarter cash-flow panel for {REAL_SYMBOL}, got {len(rows)} "
            f"row(s) -- finstack's yfinance-backed coverage may have changed shape"
        )
        for row in rows:
            assert row["period_end"], "row missing period_end"
            assert any(row[k] is not None for k in ("ocf", "cfi", "cff", "capex", "fcf")), (
                f"row for period {row['period_end']} has every cash-flow figure NULL"
            )

    def test_real_stock_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own ensure_schema()/upsert_cashflow()
        into a throwaway Postgres schema, then read a real numeric row back and validate
        it's ML-usable (real ticker-shaped symbol, real finite numeric figure)."""
        with McpStdioClient(fcf.DEFAULT_SERVER_CMD) as client:
            rows = fcf.fetch_symbol(client, REAL_SYMBOL)
        assert_non_empty_response(rows, f"fetch_symbol({REAL_SYMBOL})")

        conn = pg_memory_conn()
        conn.row_factory = sqlite3.Row
        fcf.ensure_schema(conn)
        fcf.upsert_cashflow(REAL_SYMBOL, rows, conn)

        row = conn.execute(
            "SELECT * FROM finstack_cashflow_history "
            "WHERE symbol = ? AND ocf IS NOT NULL "
            "ORDER BY period_end DESC LIMIT 1",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, (
            "no non-NULL ocf row landed in finstack_cashflow_history after upsert_cashflow"
        )
        row = dict(row)

        assert_looks_like_ticker(row["symbol"], "finstack_cashflow_history.symbol")
        assert_stored_row_ml_usable(
            row, numeric_cols=["ocf"], ticker_cols=["symbol"],
            context="finstack_cashflow_history",
        )
        assert row["period_end"], "stored row has no period_end"

    def test_upsert_is_idempotent_per_symbol_period(self):
        """Re-running the fetcher for the same symbol must refresh figures in place
        (per upsert_cashflow's own docstring), not accumulate duplicate rows -- this is
        the correctness property the weekly re-fetch cadence depends on."""
        with McpStdioClient(fcf.DEFAULT_SERVER_CMD) as client:
            rows = fcf.fetch_symbol(client, REAL_SYMBOL)
        assert_non_empty_response(rows, f"fetch_symbol({REAL_SYMBOL})")

        conn = pg_memory_conn()
        conn.row_factory = sqlite3.Row
        fcf.ensure_schema(conn)
        fcf.upsert_cashflow(REAL_SYMBOL, rows, conn)
        fcf.upsert_cashflow(REAL_SYMBOL, rows, conn)

        count = conn.execute(
            "SELECT COUNT(*) AS n FROM finstack_cashflow_history WHERE symbol = ?",
            (REAL_SYMBOL,),
        ).fetchone()
        assert dict(count)["n"] == len(rows), (
            "re-upserting the identical fetch produced duplicate rows instead of "
            "refreshing in place"
        )
