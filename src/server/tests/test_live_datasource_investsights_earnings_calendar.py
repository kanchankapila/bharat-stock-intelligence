"""Live-datasource test for investsights_earnings_calendar_fetcher.py.

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_earnings_calendar_fetcher as ecf  # noqa: E402
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable  # noqa: E402


@pytest.mark.live_datasource
class TestInvestsightsEarningsCalendarLiveDataSource:
    def test_own_fetch_parse_and_store_round_trip(self):
        session = requests.Session()
        session.headers.update(ecf.HEADERS)
        upcoming = ecf.fetch_upcoming(session)
        assert_non_empty_response(upcoming, "market/fmp-earnings upcoming")
        universe = ecf.load_nse_universe()
        rows = [r for r in (ecf.parse_row(u, universe, "2026-01-01") for u in upcoming) if r]
        resolved = [r for r in rows if r["symbol"]]
        assert_non_empty_response(resolved, "calendar rows resolved to an NSE symbol")

        con = pg_memory_conn()
        ecf.ensure_schema(con)
        ecf.store(con, rows)
        symbol, result_date = con.execute(
            "SELECT symbol, result_date FROM earnings_calendar_snapshots "
            "WHERE symbol IS NOT NULL LIMIT 1").fetchone()
        assert_stored_row_ml_usable({"symbol": symbol}, numeric_cols=[], ticker_cols=["symbol"])
        assert str(result_date)[:4].isdigit()
        est = con.execute("SELECT eps_estimated FROM earnings_calendar_snapshots "
                          "WHERE eps_estimated IS NOT NULL LIMIT 1").fetchone()
        assert est is not None, "no row carried an EPS estimate"
        assert_stored_row_ml_usable({"eps_estimated": est[0]}, numeric_cols=["eps_estimated"], ticker_cols=[])
