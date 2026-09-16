"""Live-datasource test for investsights_corporate_actions_fetcher.py
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

import investsights_corporate_actions_fetcher as ica
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable


def _session():
    s = requests.Session()
    s.headers.update(ica.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsCorporateActionsLiveDataSource:
    def test_real_fetch_returns_nse_filing_sourced_actions(self):
        actions = ica.fetch_filed_actions(_session(), days_back=45, days_ahead=180)
        assert_non_empty_response(actions, "market/corporate-actions")
        row = actions[0]
        assert row.get("symbol"), f"row missing symbol: {row}"
        assert row.get("source_url", "").startswith("https://nsearchives.nseindia.com/"), (
            f"expected an authoritative NSE filing URL, got: {row.get('source_url')!r}"
        )

    def test_own_parser_and_writer_round_trip_against_real_universe(self):
        # Uses this fetcher's OWN load_nse_universe() against the real DB, per the
        # live_datasource mandate -- not a hand-picked symbol set that could go stale.
        session = _session()
        actions = ica.fetch_filed_actions(session, days_back=45, days_ahead=180)
        universe = ica.load_nse_universe()
        assert_non_empty_response(list(universe), "nse_stocks universe")

        rows = [r for r in (ica.parse_action(a, universe) for a in actions) if r is not None]
        assert_non_empty_response(rows, "resolved filed-action rows")

        con = pg_memory_conn()
        ica.ensure_schema(con)
        stored = ica.store(con, rows)
        assert stored == len(rows)

        cur = con.execute(
            "SELECT symbol, source_url, filing_date FROM nse_filed_corporate_actions LIMIT 1"
        )
        symbol, source_url, filing_date = cur.fetchone()
        assert_stored_row_ml_usable(
            {"symbol": symbol, "source_url": source_url, "filing_date": filing_date},
            numeric_cols=[], ticker_cols=["symbol"],
        )
        assert source_url

    def test_days_ahead_zero_still_returns_backward_looking_actions(self):
        """A pure days_back window (no forward-looking upcoming actions) must still work --
        this is the shape a nightly ohlcv_adjust cross-validation run would actually use."""
        actions = ica.fetch_filed_actions(_session(), days_back=45, days_ahead=0)
        assert isinstance(actions, list)   # may be empty on a quiet day, must not error
