"""
Concrete live_datasource tests for the InvestSights + Tapetide endpoints promoted 2026-07-30
from updated_urls.json. Both providers resolve stocks directly by plain NSE symbol (confirmed
live via InvestSights' own /symbols/resolve/{symbol} endpoint) -- no opaque per-provider ID
needed, unlike Trading80/MarketsMojo/StockEdge.

RELIANCE is used as the real, well-known stock, resolved from scripts/stocklist.json.
"""

import json
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from endpoint_registry import CURATED_EXTRA_ENDPOINTS, render_endpoint_url
from extra_endpoints_fetcher import fetch_url, save_response, ensure_schema
import extra_features_parser as efp
from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite

STOCKLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "stocklist.json")

NEW_ENDPOINTS = {
    "investsights_score", "investsights_pe_band", "investsights_dcf_valuation",
    "investsights_growth_metrics", "investsights_pros_cons",
    "tapetide_score", "tapetide_analyst_ratings", "tapetide_forecasts",
}


def _real_stock():
    with open(STOCKLIST_PATH, "r", encoding="utf-8") as f:
        stocks = json.load(f)
    matches = [s for s in stocks if s.get("symbol") == "RELIANCE"]
    assert matches, "RELIANCE must exist in scripts/stocklist.json"
    return matches[0]


def _make_test_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestInvestSightsTapetideLiveDataSource:
    @pytest.fixture(autouse=True)
    def _setup(self):
        self.stock = _real_stock()
        self.endpoints = {e.name: e for e in CURATED_EXTRA_ENDPOINTS}
        self.con = _make_test_db()
        self.cur = self.con.cursor()
        yield
        self.con.close()

    def _fetch(self, name: str) -> str:
        endpoint = self.endpoints[name]
        url = render_endpoint_url(endpoint, self.stock)
        assert url, f"{name}: could not render a URL for RELIANCE"
        data = fetch_url(url)
        assert_non_empty_response(data, name)
        save_response(self.cur, self.stock["symbol"], name, data)
        self.con.commit()
        return data

    # ── Parsed endpoints ──

    def test_investsights_score(self):
        data = self._fetch("investsights_score")
        parsed = json.loads(data)
        assert parsed.get("symbol") == "RELIANCE"
        feat = efp.extract_features(self.stock["symbol"], [("investsights_score", data)])
        assert_numeric_and_finite(feat["ext_is_overall_score"], "ext_is_overall_score")
        assert_numeric_and_finite(feat["ext_is_percentile_rank"], "ext_is_percentile_rank")
        assert 0 <= feat["ext_is_overall_score"] <= 100
        assert 0 <= feat["ext_is_percentile_rank"] <= 100

    def test_tapetide_score(self):
        data = self._fetch("tapetide_score")
        parsed = json.loads(data)
        assert parsed.get("meta", {}).get("symbol") == "RELIANCE"
        feat = efp.extract_features(self.stock["symbol"], [("tapetide_score", data)])
        assert_numeric_and_finite(feat["ext_tt_score"], "ext_tt_score")
        assert 0 <= feat["ext_tt_score"] <= 100

    # ── Unparsed (archived raw) endpoints ──

    def test_investsights_pe_band(self):
        data = self._fetch("investsights_pe_band")
        parsed = json.loads(data)
        assert_non_empty_response(parsed, "investsights_pe_band")

    def test_investsights_dcf_valuation(self):
        data = self._fetch("investsights_dcf_valuation")
        parsed = json.loads(data)
        assert_non_empty_response(parsed, "investsights_dcf_valuation")

    def test_investsights_growth_metrics(self):
        data = self._fetch("investsights_growth_metrics")
        parsed = json.loads(data)
        assert_non_empty_response(parsed, "investsights_growth_metrics")

    def test_investsights_pros_cons(self):
        data = self._fetch("investsights_pros_cons")
        parsed = json.loads(data)
        assert parsed.get("symbol") == "RELIANCE"
        assert_non_empty_response(parsed.get("pros"), "investsights_pros_cons.pros")

    def test_tapetide_analyst_ratings(self):
        data = self._fetch("tapetide_analyst_ratings")
        parsed = json.loads(data)
        assert_non_empty_response(parsed.get("data"), "tapetide_analyst_ratings.data")

    def test_tapetide_forecasts(self):
        data = self._fetch("tapetide_forecasts")
        parsed = json.loads(data)
        assert_non_empty_response(parsed.get("data"), "tapetide_forecasts.data")


def test_all_new_endpoints_are_covered_by_a_test_above():
    actual = {e.name for e in CURATED_EXTRA_ENDPOINTS if e.provider in ("InvestSights", "Tapetide")}
    assert actual == NEW_ENDPOINTS, (
        f"InvestSights/Tapetide entries changed but this test file wasn't updated. "
        f"Missing tests for: {actual - NEW_ENDPOINTS}. Stale tests for: {NEW_ENDPOINTS - actual}."
    )
