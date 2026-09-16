"""Live-datasource test for investsights_investor_activity_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

Beyond the standard fetch -> own parser -> own writer -> ML-usability round trip, this pins the
one endpoint quirk that would otherwise fail silently: `symbol` on activity rows is sometimes a
raw BSE numeric scrip code rather than an NSE ticker (live-confirmed for Dynavision Ltd,
"517238"), and the fetcher must drop those rather than write a non-ticker into `symbol`.
"""
import os
import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_investor_activity_fetcher as isa
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response


def _session():
    s = requests.Session()
    s.headers.update(isa.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsInvestorActivityLiveDataSource:
    def test_real_fetch_returns_superstar_investors_with_slugs(self):
        investors = isa.fetch_superstar_investors(_session(), limit=10)
        assert_non_empty_response(investors, "fetch_superstar_investors()")
        for inv in investors:
            assert inv.get("slug"), "every investor must carry a slug (needed for /activity)"
            assert inv.get("is_superstar") is True, "only_superstars=true must only return superstars"

    def test_per_investor_activity_carries_real_changes(self):
        investors = isa.fetch_superstar_investors(_session(), limit=5)
        assert investors, "need at least one superstar investor to test activity fetch"
        session = _session()
        found_valid_change = False
        for inv in investors:
            changes = isa.fetch_investor_activity(session, inv["slug"], limit=50)
            if not changes:
                continue
            found_valid_change = True
            for c in changes[:10]:
                assert c.get("change_type") in {"entry", "exit", "increase", "decrease"}, (
                    f"unexpected change_type: {c.get('change_type')!r}"
                )
                assert c.get("curr_period_date"), "expected a real period date on each change"
        assert found_valid_change, "no investor in the sample had any recorded activity"

    def test_non_nse_symbol_is_dropped_not_corrupted(self):
        """Live-confirmed 2026-08-03: Vijay Kumar Reddy's holdings mix a real ticker
        (APOLSINHOT) with a raw BSE scrip code (517238 for Dynavision Ltd) in the same
        `symbol` field. parse_change() must drop the BSE-code row, not pass it through."""
        universe = {"APOLSINHOT", "RELIANCE", "TCS"}   # deliberately excludes "517238"
        raw_ticker = {"id": 1, "symbol": "APOLSINHOT", "change_type": "entry",
                      "curr_period_date": "2026-03-01", "curr_pct_holding": 1.97,
                      "pct_holding_change": 1.97}
        raw_bse_code = {"id": 2, "symbol": "517238", "change_type": "entry",
                         "curr_period_date": "2026-03-01", "curr_pct_holding": 53.4,
                         "pct_holding_change": 53.4}

        kept = isa.parse_change("vijay-kumar-reddy", "Vijay Kumar Reddy", raw_ticker, universe)
        dropped = isa.parse_change("vijay-kumar-reddy", "Vijay Kumar Reddy", raw_bse_code, universe)

        assert kept is not None
        assert_looks_like_ticker(kept["symbol"], "superstar_investor_activity.symbol")
        assert dropped is None, "a raw BSE numeric scrip code must never reach 'symbol'"

    def test_stored_rows_are_ml_usable(self):
        investors = isa.fetch_superstar_investors(_session(), limit=10)
        assert investors
        universe = isa.load_nse_universe()
        session = _session()
        rows = []
        for inv in investors:
            changes = isa.fetch_investor_activity(session, inv["slug"], limit=50)
            rows.extend(
                r for r in (isa.parse_change(inv["slug"], inv.get("canonical_name"), c, universe)
                            for c in changes) if r is not None
            )
            if rows:
                break
        assert rows, "no usable (NSE-tickered) activity rows found across the sample"

        con = pg_memory_conn()
        isa.ensure_schema(con)
        assert isa.store(con, rows) == len(rows)

        symbol, change_type, period = con.execute(
            "SELECT symbol, change_type, period_end_date FROM superstar_investor_activity LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        assert change_type in {"entry", "exit", "increase", "decrease"}
        assert len(period) == 10 and period[4] == "-", f"period_end_date not ISO: {period}"
