"""
Concrete live_datasource tests for the 6 endpoints promoted 2026-08-03 (round 4) after the
urls.txt field-analysis pass (docs/url_explorer/DATA_CATEGORIZATION_AND_USAGE.md):
  - tickertape_mmi, mc_deals_insight_top_investor, investsights_investors_list,
    investsights_concall_recent, investsights_sector_rrg, investsights_sector_correlation
All 6 are market-wide (no per-stock id needed).
"""

import json
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

from endpoint_registry import CURATED_EXTRA_ENDPOINTS, render_endpoint_url
from extra_endpoints_fetcher import fetch_url, save_response, ensure_schema
from live_datasource_helpers import assert_non_empty_response

ROUND4_ENDPOINTS = {
    "tickertape_mmi", "mc_deals_insight_top_investor", "investsights_investors_list",
    "investsights_concall_recent", "investsights_sector_rrg", "investsights_sector_correlation",
}


def _make_test_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestRound4EndpointsLiveDataSource:
    @pytest.fixture(autouse=True)
    def _setup(self):
        self.endpoints = {e.name: e for e in CURATED_EXTRA_ENDPOINTS}
        self.con = _make_test_db()
        self.cur = self.con.cursor()
        yield
        self.con.close()

    def _fetch_market(self, name: str) -> str:
        endpoint = self.endpoints[name]
        url = render_endpoint_url(endpoint)
        assert url, f"{name}: could not render a market-wide URL"
        data = fetch_url(url)
        assert_non_empty_response(data, name)
        save_response(self.cur, "MARKET", name, data)
        self.con.commit()
        row = self.cur.execute(
            "SELECT response_json FROM extra_endpoint_responses WHERE symbol = ? AND endpoint_name = ?",
            ("MARKET", name),
        ).fetchone()
        assert row is not None and row[0], f"{name}: save_response did not persist a row"
        return data

    def test_tickertape_mmi(self):
        data = self._fetch_market("tickertape_mmi")
        parsed = json.loads(data)
        assert parsed.get("success") is True
        body = parsed.get("data", {})
        indicator = body.get("indicator")
        assert isinstance(indicator, (int, float)), "expected a numeric MMI indicator value"
        assert 0 <= indicator <= 100, f"MMI indicator out of the documented 0-100 range: {indicator}"
        assert_non_empty_response(body.get("lastDay"), "tickertape_mmi.lastDay")

    def test_mc_deals_insight_top_investor(self):
        data = self._fetch_market("mc_deals_insight_top_investor")
        parsed = json.loads(data)
        assert parsed.get("success") == 1
        top_investor = parsed.get("data", {}).get("topInvestor")
        assert_non_empty_response(top_investor, "mc_deals_insight_top_investor.data.topInvestor")
        for row in top_investor[:5]:
            assert row.get("symbol"), "expected a real NSE symbol on each deal row"
            assert row.get("boughtBy"), "expected a counterparty name on each deal row"

    def test_investsights_investors_list(self):
        data = self._fetch_market("investsights_investors_list")
        parsed = json.loads(data)
        investors = parsed.get("investors")
        assert_non_empty_response(investors, "investsights_investors_list.investors")
        for inv in investors[:5]:
            assert inv.get("slug"), "expected a real investor slug (needed by the activity fetcher)"
            assert inv.get("is_superstar") is True, "only_superstars=true should only return superstars"

    def test_investsights_concall_recent(self):
        data = self._fetch_market("investsights_concall_recent")
        parsed = json.loads(data)
        # No top-level "success" key on this endpoint (unlike sibling investsights_* endpoints,
        # confirmed live 2026-08-03) -- items/count is the whole envelope.
        items = parsed.get("items")
        assert_non_empty_response(items, "investsights_concall_recent.items")
        for item in items[:5]:
            assert item.get("symbol"), "expected a real symbol on each concall item"
            assert item.get("key_takeaway"), "expected the AI-generated takeaway text"

    def test_investsights_sector_rrg(self):
        data = self._fetch_market("investsights_sector_rrg")
        parsed = json.loads(data)
        assert parsed.get("success") is True
        sectors = parsed.get("sectors")
        assert_non_empty_response(sectors, "investsights_sector_rrg.sectors")
        for s in sectors[:5]:
            assert s.get("sector"), "expected a real sector name"
            assert s.get("current_quadrant") in {"Leading", "Weakening", "Lagging", "Improving"}, (
                f"unexpected RRG quadrant label: {s.get('current_quadrant')!r}"
            )

    def test_investsights_sector_correlation(self):
        data = self._fetch_market("investsights_sector_correlation")
        parsed = json.loads(data)
        assert parsed.get("success") is True
        assert_non_empty_response(parsed.get("sector_stats"), "investsights_sector_correlation.sector_stats")
        assert_non_empty_response(parsed.get("matrix"), "investsights_sector_correlation.matrix")


def test_round4_endpoints_are_covered_by_a_test_above():
    actual = {e.name for e in CURATED_EXTRA_ENDPOINTS if e.name in ROUND4_ENDPOINTS}
    assert actual == ROUND4_ENDPOINTS, (
        f"Round-4 CURATED_EXTRA_ENDPOINTS entries changed but this test file wasn't updated. "
        f"Missing: {ROUND4_ENDPOINTS - actual}. Stale: {actual - ROUND4_ENDPOINTS}."
    )
