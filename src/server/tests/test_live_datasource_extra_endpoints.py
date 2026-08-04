"""
Concrete live_datasource tests for the 12 curated endpoints in
endpoint_registry.CURATED_EXTRA_ENDPOINTS (fetched by extra_endpoints_fetcher.py, parsed by
extra_features_parser.py). These pre-existed the endpoint_registry.py refactor but had zero
live-hitting tests despite being the MANDATORY rule in CLAUDE.md's "Adding a New Data Source"
section — the exact gap that let the 2026-07-23 URL-as-symbol corruption ship undetected
elsewhere in this codebase.

RELIANCE is used as the real, well-known stock (companyid/stockid resolved from
scripts/stocklist.json, never hardcoded/guessed — per the Ticker Resolution Strategy).

Three endpoints (marketservices_shareholding, trading80_header_info, marketsmojo_header_info)
have a real parser in extra_features_parser.py — those get the full pattern (fetch -> parse
with the fetcher's own function -> assert ML-usable -> store -> read back).

The other 9 endpoints are archived raw only (no parser exists yet — extra_endpoint_responses
just stores the response text). For those this test can only guard reachability + response
shape (JSON/JSONP well-formedness) + real DB round-trip; promote to a full parser (with its
own dedicated test per the pattern above) if/when a feature is built on top of them.
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

PARSED_ENDPOINTS = {"marketservices_shareholding", "trading80_header_info", "marketsmojo_header_info"}


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


def _strip_jsonp(text: str, prefix: str, suffix: str) -> dict:
    """Minimal unwrap for the two JSONP-style responses -- test-only convenience,
    not a production parser (neither endpoint has a real parser yet)."""
    body = text.strip()
    assert body.startswith(prefix), f"expected JSONP prefix {prefix!r}, got: {body[:40]!r}"
    assert body.endswith(suffix) or not suffix, f"expected JSONP suffix {suffix!r}, got: {body[-10:]!r}"
    inner = body[len(prefix):]
    if suffix:
        inner = inner[: -len(suffix)]
    return json.loads(inner)


@pytest.mark.live_datasource
class TestExtraEndpointsLiveDataSource:
    """One method per curated endpoint. Each hits the real URL for RELIANCE using the exact
    render_endpoint_url() code path extra_endpoints_fetcher.py itself uses (not a hand-rolled
    URL), then stores through the real save_response() into a throwaway DB."""

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
        assert url, f"{name}: could not render a URL for RELIANCE (missing required id?)"
        data = fetch_url(url)
        assert_non_empty_response(data, name)
        save_response(self.cur, self.stock["symbol"], name, data)
        self.con.commit()
        row = self.cur.execute(
            "SELECT response_json FROM extra_endpoint_responses WHERE symbol = ? AND endpoint_name = ?",
            (self.stock["symbol"], name),
        ).fetchone()
        assert row is not None and row[0], f"{name}: save_response did not persist a row"
        return data

    # ── Parsed endpoints: full fetch -> real parser -> ML-usable assertions ──

    def test_marketservices_shareholding(self):
        data = self._fetch("marketservices_shareholding")
        feat = efp.extract_features(self.stock["symbol"], [("marketservices_shareholding", data)])
        assert_numeric_and_finite(feat["ext_fii_holding_pct"], "ext_fii_holding_pct")
        assert_numeric_and_finite(feat["ext_dii_holding_pct"], "ext_dii_holding_pct")
        assert 0 <= feat["ext_fii_holding_pct"] <= 100
        assert 0 <= feat["ext_dii_holding_pct"] <= 100

    def test_trading80_header_info(self):
        data = self._fetch("trading80_header_info")
        feat = efp.extract_features(self.stock["symbol"], [("trading80_header_info", data)])
        assert_numeric_and_finite(feat["ext_t80_tech_score"], "ext_t80_tech_score")
        assert_numeric_and_finite(feat["ext_t80_quality_rank"], "ext_t80_quality_rank")

    def test_marketsmojo_header_info(self):
        data = self._fetch("marketsmojo_header_info")
        feat = efp.extract_features(self.stock["symbol"], [("marketsmojo_header_info", data)])
        assert_numeric_and_finite(feat["ext_mojo_quality_rank"], "ext_mojo_quality_rank")

    # ── Unparsed endpoints: reachability + response-shape + DB round-trip only ──

    def test_mfapps_mfsInvestingInStock(self):
        data = self._fetch("mfapps_mfsInvestingInStock")
        parsed = _strip_jsonp(data, "ajaxResponse(", ")")
        assert "searchresult" in parsed, "expected MF holder list under 'searchresult'"

    def test_et_companypagedata(self):
        data = self._fetch("et_companypagedata")
        parsed = json.loads(data.strip())
        assert_non_empty_response(parsed, "et_companypagedata")

    def test_et_bsensejson(self):
        data = self._fetch("et_bsensejson")
        parsed = _strip_jsonp(data, "var etmarketcompanydata=", "")
        assert "NewDataSet" in parsed, "expected live-quote wrapper under 'NewDataSet'"
        rows = parsed["NewDataSet"]
        assert_non_empty_response(rows, "et_bsensejson.NewDataSet")
        assert rows[0].get("Symbol", "").upper() == self.stock["symbol"], (
            "et_bsensejson row Symbol should match the requested RELIANCE stock, not drift "
            "onto an unrelated/default company (companyid mis-resolution would surface here)"
        )

    def test_trading80_technical_card(self):
        data = self._fetch("trading80_technical_card")
        parsed = json.loads(data.strip())
        assert parsed.get("code") in (200, "200"), f"unexpected response code: {parsed.get('code')}"
        assert_non_empty_response(parsed.get("data"), "trading80_technical_card.data")

    def test_marketsmojo_quality_vcard(self):
        data = self._fetch("marketsmojo_quality_vcard")
        parsed = json.loads(data.strip())
        assert parsed.get("code") in (200, "200"), f"unexpected response code: {parsed.get('code')}"

    def test_marketsmojo_thingsknow(self):
        data = self._fetch("marketsmojo_thingsknow")
        parsed = json.loads(data.strip())
        assert parsed.get("code") in (200, "200"), f"unexpected response code: {parsed.get('code')}"

    def test_marketsmojo_return_contribution(self):
        data = self._fetch("marketsmojo_return_contribution")
        parsed = json.loads(data.strip())
        assert parsed.get("code") in (200, "200"), f"unexpected response code: {parsed.get('code')}"
        assert_non_empty_response(parsed.get("data"), "marketsmojo_return_contribution.data")

    # ── Market-wide endpoints (no per-stock id needed) ──

    def _fetch_market(self, name: str) -> str:
        endpoint = self.endpoints[name]
        url = render_endpoint_url(endpoint)
        assert url, f"{name}: could not render a market-wide URL"
        data = fetch_url(url)
        assert_non_empty_response(data, name)
        save_response(self.cur, "MARKET", name, data)
        self.con.commit()
        return data

    def test_marketsmojo_marketaction(self):
        data = self._fetch_market("marketsmojo_marketaction")
        parsed = json.loads(data.strip())
        assert parsed.get("code") in (200, "200"), f"unexpected response code: {parsed.get('code')}"
        assert_non_empty_response(parsed.get("data", {}).get("market_action"), "marketsmojo_marketaction")

    def test_trading80_call_alerts(self):
        data = self._fetch_market("trading80_call_alerts")
        parsed = json.loads(data.strip())
        assert parsed.get("code") in (200, "200"), f"unexpected response code: {parsed.get('code')}"

    def test_stockedge_high_delivery_qty(self):
        """Promoted 2026-07-30 from updated_urls.json / explore_mc_tl.py's build_stockedge_urls()
        -- the one StockEdge market-wide URL of 6 candidates that still returns real data live
        (the other 5 either needed a StockEdge-specific per-stock id with no resolver, or 404'd)."""
        data = self._fetch_market("stockedge_high_delivery_qty")
        parsed = json.loads(data.strip())
        alerts = parsed.get("Alerts")
        assert_non_empty_response(alerts, "stockedge_high_delivery_qty.Alerts")
        for row in alerts[:5]:
            assert row.get("Symb"), "expected a real NSE symbol in 'Symb'"
            assert row.get("Date"), "expected a real alert date"


def test_all_curated_endpoints_are_covered_by_a_test_above():
    """Guard against silently adding a new curated endpoint with no live test anywhere --
    mirrors the intent of the MANDATORY 'every new or existing data-source fetcher needs a
    live_datasource test' rule in CLAUDE.md. Excludes endpoint NAMES (not providers -- round-3
    added more MarketsMojo/Tickertape/Trendlyne endpoints that share a provider with entries
    already covered here) that have their own test file + coverage guard elsewhere:
    test_live_datasource_investsights_tapetide.py (InvestSights/Tapetide, 2026-07-30) and
    test_live_datasource_round3_endpoints.py (round 3, 2026-07-30) -- every curated endpoint
    must be covered by exactly one guard across the three files."""
    covered = {
        "marketservices_shareholding", "mfapps_mfsInvestingInStock", "et_companypagedata",
        "et_bsensejson", "trading80_header_info", "trading80_technical_card",
        "marketsmojo_quality_vcard", "marketsmojo_thingsknow", "marketsmojo_return_contribution",
        "marketsmojo_header_info", "marketsmojo_marketaction", "trading80_call_alerts",
        "stockedge_high_delivery_qty",
    }
    covered_elsewhere = {
        "investsights_score", "investsights_pe_band", "investsights_dcf_valuation",
        "investsights_growth_metrics", "investsights_pros_cons",
        "tapetide_score", "tapetide_analyst_ratings", "tapetide_forecasts",
        "marketsmojo_stock_picks_history", "marketsmojo_results_corner",
        "tickertape_financials_income", "tickertape_estimates_history", "tickertape_deals",
        "trendlyne_market_insight", "trendlyne_mf_home",
        # Round 4 (2026-08-03) — test_live_datasource_round4_endpoints.py
        "tickertape_mmi", "mc_deals_insight_top_investor", "investsights_investors_list",
        "investsights_concall_recent", "investsights_sector_rrg", "investsights_sector_correlation",
    }
    actual = {
        e.name for e in CURATED_EXTRA_ENDPOINTS
        if e.name not in covered_elsewhere
    }
    assert actual == covered, (
        f"CURATED_EXTRA_ENDPOINTS changed but this test file wasn't updated. "
        f"Missing tests for: {actual - covered}. Stale tests for: {covered - actual}."
    )
