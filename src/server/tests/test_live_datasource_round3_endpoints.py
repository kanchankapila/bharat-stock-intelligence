"""
Concrete live_datasource tests for the 7 endpoints promoted 2026-07-30 (round 3) after
live-testing ALL 437 unique URL shapes in updated_urls.json and content-reviewing the
survivors that weren't already covered by an existing fetcher:
  - marketsmojo_stock_picks_history, marketsmojo_results_corner (market-wide)
  - tickertape_financials_income, tickertape_estimates_history (per-stock, tickertape_sid)
  - tickertape_deals, trendlyne_market_insight, trendlyne_mf_home (market-wide)

RELIANCE (tickertape_sid "RELI") is the real, well-known stock used for the per-stock
endpoints, resolved from scripts/stocklist.json.
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
from live_datasource_helpers import assert_non_empty_response

STOCKLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "stocklist.json")

ROUND3_ENDPOINTS = {
    "marketsmojo_stock_picks_history", "marketsmojo_results_corner",
    "tickertape_financials_income", "tickertape_estimates_history", "tickertape_deals",
    "trendlyne_market_insight", "trendlyne_mf_home",
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
class TestRound3EndpointsLiveDataSource:
    @pytest.fixture(autouse=True)
    def _setup(self):
        self.stock = _real_stock()
        self.endpoints = {e.name: e for e in CURATED_EXTRA_ENDPOINTS}
        self.con = _make_test_db()
        self.cur = self.con.cursor()
        yield
        self.con.close()

    def _fetch_stock(self, name: str) -> str:
        endpoint = self.endpoints[name]
        url = render_endpoint_url(endpoint, self.stock)
        assert url, f"{name}: could not render a URL for RELIANCE (tickertape_sid={self.stock.get('tickertape_sid')})"
        data = fetch_url(url)
        assert_non_empty_response(data, name)
        save_response(self.cur, self.stock["symbol"], name, data)
        self.con.commit()
        return data

    def _fetch_market(self, name: str) -> str:
        endpoint = self.endpoints[name]
        url = render_endpoint_url(endpoint)
        assert url, f"{name}: could not render a market-wide URL"
        data = fetch_url(url)
        assert_non_empty_response(data, name)
        save_response(self.cur, "MARKET", name, data)
        self.con.commit()
        return data

    def test_tickertape_financials_income(self):
        data = self._fetch_stock("tickertape_financials_income")
        parsed = json.loads(data)
        assert parsed.get("success") is True
        assert_non_empty_response(parsed.get("data"), "tickertape_financials_income.data")

    def test_tickertape_estimates_history(self):
        data = self._fetch_stock("tickertape_estimates_history")
        parsed = json.loads(data)
        assert parsed.get("success") is True

    def test_marketsmojo_stock_picks_history(self):
        data = self._fetch_market("marketsmojo_stock_picks_history")
        parsed = json.loads(data)
        assert parsed.get("code") in (200, "200")
        picks = parsed.get("data", {}).get("activestocks")
        assert_non_empty_response(picks, "marketsmojo_stock_picks_history.activestocks")
        for pick in picks[:5]:
            assert pick.get("stockname"), "expected a real stock name in the picks history"

    def test_marketsmojo_results_corner(self):
        data = self._fetch_market("marketsmojo_results_corner")
        parsed = json.loads(data)
        assert parsed.get("code") in (200, "200")
        fin_division = parsed.get("data", {}).get("fin_division")
        assert_non_empty_response(fin_division, "marketsmojo_results_corner.fin_division")
        for key in ("positive", "flat", "negative"):
            assert key in fin_division, f"expected {key!r} in results-season sentiment breakdown"

    def test_tickertape_deals_is_market_wide_and_real(self):
        data = self._fetch_market("tickertape_deals")
        parsed = json.loads(data)
        assert parsed.get("success") is True
        body = parsed.get("data", {})
        assert body.get("total", 0) > 1000, (
            "expected a large market-wide bulk/block deal count, not a single-stock result"
        )
        items = body.get("items")
        assert_non_empty_response(items, "tickertape_deals.items")
        for item in items[:5]:
            assert item.get("ticker"), "expected a real ticker on each deal row"

    def test_trendlyne_market_insight(self):
        data = self._fetch_market("trendlyne_market_insight")
        parsed = json.loads(data)
        insights = parsed.get("body", {}).get("marketInsights")
        assert_non_empty_response(insights, "trendlyne_market_insight.marketInsights")
        for item in insights[:5]:
            assert item.get("stockCode"), "expected a real stock code on each insight item"

    def test_trendlyne_mf_home(self):
        data = self._fetch_market("trendlyne_mf_home")
        parsed = json.loads(data)
        assert_non_empty_response(parsed.get("body"), "trendlyne_mf_home.body")


def test_round3_endpoints_are_covered_by_a_test_above():
    actual = {e.name for e in CURATED_EXTRA_ENDPOINTS if e.name in ROUND3_ENDPOINTS}
    assert actual == ROUND3_ENDPOINTS, (
        f"Round-3 CURATED_EXTRA_ENDPOINTS entries changed but this test file wasn't updated. "
        f"Missing: {ROUND3_ENDPOINTS - actual}. Stale: {actual - ROUND3_ENDPOINTS}."
    )
