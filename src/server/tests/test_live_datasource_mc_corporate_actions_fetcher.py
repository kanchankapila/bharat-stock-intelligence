"""Live-datasource test for mc_corporate_actions_fetcher.py
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

import mc_corporate_actions_fetcher as mca
from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite


def _session():
    s = requests.Session()
    s.headers.update(mca.HEADERS)
    return s


@pytest.mark.live_datasource
class TestMcCorporateActionsLiveDataSource:
    def test_real_fetch_reliance_has_dividends_bonus_and_rights(self):
        # scId=RI is RELIANCE's real MoneyControl scId (this codebase's own resolvers already
        # confirm this mapping) -- a stock with deep, well-known corporate-action history.
        data = mca.fetch_actions(_session(), "RI")
        assert_non_empty_response(data.get("dividends"), "RI.dividends")
        assert_non_empty_response(data.get("bonus"), "RI.bonus")
        assert_non_empty_response(data.get("rights"), "RI.rights")

    def test_real_fetch_nestleind_has_a_real_1_to_10_split(self):
        # scId=NI is NESTLEIND's real scId (resolved via MC's own autosuggest during this
        # fetcher's build) -- pins the exact split ohlcv_adjust.py's own docstring documents.
        data = mca.fetch_actions(_session(), "NI")
        splits = data.get("splits")
        assert_non_empty_response(splits, "NI.splits")
        row = next((r for r in splits if str(r.get("record_date", "")).startswith("2024-01")), None)
        assert row is not None, f"expected the 2024-01-05 split among {splits}"
        assert_numeric_and_finite(row.get("old_fv"), "old_fv")
        assert_numeric_and_finite(row.get("new_fv"), "new_fv")
        assert float(row["old_fv"]) / float(row["new_fv"]) == pytest.approx(10.0)

    def test_unknown_scid_returns_empty_not_a_crash(self):
        data = mca.fetch_actions(_session(), "ZZZZ99")
        assert data == {}

    def test_parsed_and_stored_rows_are_ml_usable(self):
        session = _session()
        data = mca.fetch_actions(session, "RI")
        rows = mca.parse_payload("RELIANCE", data)
        assert_non_empty_response(rows, "parsed RELIANCE rows")

        con = sqlite3.connect(":memory:")
        mca.ensure_schema(con)
        stored = mca.store(con, rows)
        assert stored == len(rows)

        symbol, atype, record_date = con.execute(
            "SELECT symbol, action_type, record_date FROM stock_corporate_action_history "
            "WHERE action_type = 'bonus' LIMIT 1"
        ).fetchone()
        assert symbol == "RELIANCE"
        assert atype == "bonus"
        assert record_date and len(record_date) == 10, f"record_date not ISO: {record_date!r}"

    def test_bonus_and_split_ratio_factors_are_real_finite_numbers(self):
        session = _session()
        rows = mca.parse_payload("NESTLEIND", mca.fetch_actions(session, "NI"))
        ratio_rows = [r for r in rows if r["action_type"] in ("bonus", "split")]
        assert_non_empty_response(ratio_rows, "NESTLEIND bonus/split rows")
        for r in ratio_rows:
            assert_numeric_and_finite(r["ratio_factor"], f"{r['action_type']} ratio_factor")
            assert 0 < r["ratio_factor"] < 1000, f"implausible ratio_factor: {r}"
