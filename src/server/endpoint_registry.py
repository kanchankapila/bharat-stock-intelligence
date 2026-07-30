#!/usr/bin/env python3
"""
Validated endpoint registry for extra data ingestion.

The root ai_endpoint_memory.json is a discovery catalogue, not a fetch plan. This
module validates that catalogue, persists registry metadata for auditability, and
exposes only parser-ready endpoints to the existing extra_endpoints_fetcher path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from collections import Counter, defaultdict
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MEMORY_PATH = REPO_ROOT / "ai_endpoint_memory.json"
DEFAULT_REFERENCE_PATHS = (
    REPO_ROOT / "src" / "server" / "urls_sample.json",
    Path("D:/Github/urls-explorer/urls_sample.txt"),
)

STOCK_FIELD_PARAMS = {
    "symbol": "symbol",
    "symbolName": "symbol",
    "exchangeSymbol": "symbol",
    "scId": "mcsymbol",
    "sc_id": "mcsymbol",
    "sc_did": "mcsymbol",
    "scDid": "mcsymbol",
    "companyid": "companyid",
    "companyId": "companyid",
    "sid": "stockid",
    "stockid": "stockid",
    "stockID": "stockid",
    "tlid": "tlid",
    "fincode": "fincode",
    "scripcode": "scripcode",
}


class ReferenceValueIndex:
    def __init__(self) -> None:
        self._values: dict[tuple[str, ...], Counter[str]] = defaultdict(Counter)
        self._query_values: dict[tuple[str, ...], list[dict[str, str]]] = defaultdict(list)

    def add_url(self, url: str, provider: str | None = None) -> None:
        parsed = urlsplit(url)
        host = parsed.netloc.lower()
        path = _normalize_path(parsed.path)
        path_name = _path_name(parsed.path)
        provider_key = _provider_key(provider)
        query_values: dict[str, str] = {}
        for key, value in parse_qsl(parsed.query, keep_blank_values=True):
            normalized_value = value.strip()
            if normalized_value.lower() == "default":
                continue
            query_values[key] = normalized_value
            for index_key in (
                ("provider_host_path", provider_key, host, path, key),
                ("host_path", host, path, key),
                ("provider_path_name", provider_key, path_name, key),
                ("path_name", path_name, key),
                ("provider_param", provider_key, key),
                ("param", key),
            ):
                self._values[index_key][normalized_value] += 1
        if query_values:
            for index_key in (
                ("provider_host_path", provider_key, host, path),
                ("host_path", host, path),
                ("provider_path_name", provider_key, path_name),
                ("path_name", path_name),
            ):
                self._query_values[index_key].append(query_values)

    def sample_query_values(self, provider: str | None, url: str) -> dict[str, str]:
        parsed = urlsplit(url)
        host = parsed.netloc.lower()
        path = _normalize_path(parsed.path)
        path_name = _path_name(parsed.path)
        provider_key = _provider_key(provider)
        for index_key in (
            ("provider_host_path", provider_key, host, path),
            ("host_path", host, path),
            ("provider_path_name", provider_key, path_name),
            ("path_name", path_name),
        ):
            examples = self._query_values.get(index_key)
            if examples:
                return examples[0]
        return {}

    def sample_value(self, provider: str | None, url: str, param: str) -> str | None:
        parsed = urlsplit(url)
        host = parsed.netloc.lower()
        path = _normalize_path(parsed.path)
        path_name = _path_name(parsed.path)
        provider_key = _provider_key(provider)
        for index_key in (
            ("provider_host_path", provider_key, host, path, param),
            ("host_path", host, path, param),
            ("provider_path_name", provider_key, path_name, param),
            ("path_name", path_name, param),
            ("provider_param", provider_key, param),
            ("param", param),
        ):
            value = _only_value(self._values.get(index_key))
            if value is not None:
                return value
        return None


@dataclass(frozen=True)
class EndpointDefinition:
    name: str
    url_template: str
    scope: str
    required_ids: tuple[str, ...]
    source: str
    provider: str
    category: str
    http_method: str = "GET"
    data_format: str = "JSON"
    feature_targets: tuple[str, ...] = field(default_factory=tuple)
    raw_id: str | None = None
    enabled: bool = False
    parser_ready: bool = False
    validation_status: str = "valid"
    validation_errors: tuple[str, ...] = field(default_factory=tuple)

    def required_ids_json(self) -> str:
        return json.dumps(list(self.required_ids), sort_keys=True)

    def feature_targets_json(self) -> str:
        return json.dumps(list(self.feature_targets), sort_keys=True)

    def validation_errors_json(self) -> str:
        return json.dumps(list(self.validation_errors), sort_keys=True)


CURATED_EXTRA_ENDPOINTS: tuple[EndpointDefinition, ...] = (
    EndpointDefinition(
        name="marketservices_shareholding",
        url_template="https://marketservices.indiatimes.com/marketservices/shareholding?companyid={companyid}",
        scope="stock",
        required_ids=("companyid",),
        source="curated_extra",
        provider="Indiatimes",
        category="Ownership & Institutional Holdings",
        feature_targets=(
            "ext_fii_holding_pct",
            "ext_dii_holding_pct",
            "ext_fii_qoq_chg",
            "ext_dii_qoq_chg",
        ),
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="mfapps_mfsInvestingInStock",
        url_template="https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm?pagesize=25&sortby=numberOfSharesHeld&companyid={companyid}&marketcap=&callback=ajaxResponse&pageno=1",
        scope="stock",
        required_ids=("companyid",),
        source="curated_extra",
        provider="Indiatimes",
        category="Ownership & Institutional Holdings",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="et_companypagedata",
        url_template="https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid={companyid}",
        scope="stock",
        required_ids=("companyid",),
        source="curated_extra",
        provider="Indiatimes",
        category="Fundamental Financials & Valuation",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="et_bsensejson",
        url_template="https://json.bselivefeeds.indiatimes.com/ET_Community/bsensejson?companyid={companyid}",
        scope="stock",
        required_ids=("companyid",),
        source="curated_extra",
        provider="Indiatimes",
        category="Price & Technical Charts",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="trading80_header_info",
        url_template="https://frapi.trading80.com/stocks_stocksid/header_info?sid={stockid}&exchange=0",
        scope="stock",
        required_ids=("stockid",),
        source="curated_extra",
        provider="Trading80",
        category="Screener & Quantitative Discovery",
        feature_targets=(
            "ext_t80_tech_score",
            "ext_t80_quality_rank",
            "ext_t80_valuation_rank",
            "ext_t80_financial_pts",
        ),
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="trading80_technical_card",
        url_template="https://www.trading80.com/technical_card/getCardInfo?sid={stockid}&se=bse&cardlist=sectPrice_techScore,sectPrice_indiScale,sectIndigraph_graph,sectMacd_macd_w,sectMacd_macd_m,sectRsi_rsi_w,sectRsi_rsi_m,sectBb_bb_w,sectBb_bb_m,sectMa_ma_w,sectKst_kst_w,sectKst_kst_m,sectDow_dow_w,sectDow_dow_m,sectObv_obv_w,sectObv_obv_m",
        scope="stock",
        required_ids=("stockid",),
        source="curated_extra",
        provider="Trading80",
        category="Price & Technical Charts",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="marketsmojo_quality_vcard",
        url_template="https://frapi.marketsmojo.com/stocks_quality/vcardinfo?sid={stockid}",
        scope="stock",
        required_ids=("stockid",),
        source="curated_extra",
        provider="MarketsMojo",
        category="Fundamental Financials & Valuation",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="marketsmojo_thingsknow",
        url_template="https://frapi.marketsmojo.com/Stocks_Thingsknow/thingsknow?sid={stockid}&exchange=0",
        scope="stock",
        required_ids=("stockid",),
        source="curated_extra",
        provider="MarketsMojo",
        category="News, Filings & AI Sentiment",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="marketsmojo_return_contribution",
        url_template="https://frapi.marketsmojo.com/stocks_Stocksid/returnContri_info?se=&cardlist=&period=&alphabet=&sid={stockid}&stockID={stockid}&exchange=0&",
        scope="stock",
        required_ids=("stockid",),
        source="curated_extra",
        provider="MarketsMojo",
        category="Price & Technical Charts",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="marketsmojo_header_info",
        url_template="https://frapi.marketsmojo.com/stocks_stocksid/header_info?sid={stockid}&exchange=0",
        scope="stock",
        required_ids=("stockid",),
        source="curated_extra",
        provider="MarketsMojo",
        category="Screener & Quantitative Discovery",
        feature_targets=(
            "ext_mojo_quality_rank",
            "ext_mojo_valuation_rank",
            "ext_mojo_financial_pts",
        ),
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="marketsmojo_marketaction",
        url_template="https://frapi.marketsmojo.com/market_marketaction/getData?",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="MarketsMojo",
        category="General Market Metadata",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="trading80_call_alerts",
        url_template="https://frapi.trading80.com/callsapi/getCallAlerts?w=yes",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="Trading80",
        category="Screener & Quantitative Discovery",
        enabled=True,
        parser_ready=True,
    ),
    # Live-verified 2026-07-30 against updated_urls.json's captured URL (real high-delivery
    # alert data, dated the prior trading session). Promoted from explore_mc_tl.py's
    # build_stockedge_urls(), which already validated this one is market-wide (no per-stock
    # StockEdge ID needed -- StockEdge uses its own opaque numeric ID, unrelated to
    # stocklist.json's stockid/companyid fields, so per-stock StockEdge endpoints from that
    # same script are deliberately NOT promoted here without a real symbol->StockEdge-id
    # resolver). 3 of the 6 candidate StockEdge market-wide URLs 404'd live and were dropped;
    # this is the one that returned real, current data.
    EndpointDefinition(
        name="stockedge_high_delivery_qty",
        url_template="https://api.stockedge.com/Api/WidgetsApi/GetHighDeliveryQuantityStocks?lang=en",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="StockEdge",
        category="Screener & Quantitative Discovery",
        enabled=True,
        parser_ready=True,
    ),
    # Live-verified 2026-07-30 against updated_urls.json's captured InvestSights URLs. Unlike
    # Trading80/MarketsMojo/StockEdge, InvestSights resolves stocks directly by plain NSE symbol
    # (confirmed via its own /symbols/resolve/{symbol} endpoint) -- no opaque per-provider ID
    # needed, so these template cleanly off stocklist.json's existing `symbol` field.
    EndpointDefinition(
        name="investsights_score",
        url_template="https://investsights.in/api/v2/stocks/{symbol}/score?",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="InvestSights",
        category="Screener & Quantitative Discovery",
        feature_targets=("ext_is_overall_score", "ext_is_percentile_rank"),
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="investsights_pe_band",
        url_template="https://investsights.in/api/v2/market/pe-band/{symbol}?days=1095",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="InvestSights",
        category="Fundamental Financials & Valuation",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="investsights_dcf_valuation",
        url_template="https://investsights.in/api/v2/fundamentals/{symbol}/dcf-valuation",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="InvestSights",
        category="Fundamental Financials & Valuation",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="investsights_growth_metrics",
        url_template="https://investsights.in/api/v2/fundamentals/{symbol}/growth-metrics?period=annual&limit=1",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="InvestSights",
        category="Fundamental Financials & Valuation",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="investsights_pros_cons",
        url_template="https://investsights.in/api/v2/fundamentals/{symbol}/pros-cons?",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="InvestSights",
        category="News, Filings & AI Sentiment",
        enabled=True,
        parser_ready=True,
    ),
    # Live-verified 2026-07-30 against updated_urls.json's captured Tapetide URLs. Also resolves
    # directly by plain NSE symbol, no ID mapping needed. Tapetide's ai-chat.tapetide.com
    # sub-endpoints (insights, documents) require auth (401 "Authentication required" live) and
    # are deliberately NOT promoted here.
    EndpointDefinition(
        name="tapetide_score",
        url_template="https://api.tapetide.com/api/v1/companies/{symbol}/score",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="Tapetide",
        category="Screener & Quantitative Discovery",
        feature_targets=("ext_tt_score",),
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="tapetide_analyst_ratings",
        url_template="https://api.tapetide.com/api/v1/companies/{symbol}/analyst-ratings",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="Tapetide",
        category="Analyst Estimates & Price Targets",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="tapetide_forecasts",
        url_template="https://api.tapetide.com/api/v1/companies/{symbol}/forecasts",
        scope="stock",
        required_ids=("symbol",),
        source="curated_extra",
        provider="Tapetide",
        category="Analyst Estimates & Price Targets",
        enabled=True,
        parser_ready=True,
    ),
    # Round 3 (2026-07-30, same day): live-tested ALL 437 unique URL shapes in updated_urls.json
    # (not just a sample) at the user's request. Most of the remaining untested surface turned
    # out to be either already covered (trendlyne.com's ~35 fundamentals/json-screener/{id} paths
    # are the exact same screenpk values trendlyne_screener_discovery.py already syncs via
    # kayal.trendlyne.com -- confirmed live by cross-referencing 6 sampled ids against the real
    # trendlyne_screeners table; trendlyne.com's overview-second-part/fundamental-profile/
    # adv-technical-analysis/price-performance-analysis are already fetched verbatim by
    # trendlyne_overview_fetcher.py/trendlyne_adv_tech_fetcher.py/trendlyne_price_analysis_fetcher.py;
    # sector-industry-analysis/global-indices-analysis are already fetched by sync_tl_index_map.py)
    # or genuinely unreachable (www.ndtvprofit.com, ticker.finology.in -- 403 even with full
    # browser headers; api.niftytrader.in -- 404, a retired subdomain, webapi.niftytrader.in is
    # the live one and already used elsewhere; www.moneycontrol.com/mc/widget/* -- returns HTML
    # server-rendered fragments, not a real JSON API). The handful below are the ones that
    # survived: genuinely new data, not already fetched anywhere, live-verified working.
    EndpointDefinition(
        name="marketsmojo_stock_picks_history",
        url_template="https://frapi.marketsmojo.com/optimizer_Portfoliodignostic/getMojostocksHist",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="MarketsMojo",
        category="Screener & Quantitative Discovery",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="marketsmojo_results_corner",
        url_template="https://frapi.marketsmojo.com/market_resultscorner/getStockResult",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="MarketsMojo",
        category="Fundamental Financials & Valuation",
        enabled=True,
        parser_ready=True,
    ),
    # Tickertape's per-stock id here is tickertape_sid (already in stocklist.json, e.g. "RELI"
    # for RELIANCE) -- distinct from tapetide_score's use of the plain NSE `symbol` above.
    EndpointDefinition(
        name="tickertape_financials_income",
        url_template="https://api.tickertape.in/stocks/financials/income/{tickertape_sid}/annual/normal",
        scope="stock",
        required_ids=("tickertape_sid",),
        source="curated_extra",
        provider="Tickertape",
        category="Fundamental Financials & Valuation",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="tickertape_estimates_history",
        url_template="https://api.tickertape.in/stocks/estimates/history/{tickertape_sid}",
        scope="stock",
        required_ids=("tickertape_sid",),
        source="curated_extra",
        provider="Tickertape",
        category="Analyst Estimates & Price Targets",
        enabled=True,
        parser_ready=True,
    ),
    # Market-wide (no sids param) -- 659,545 total bulk/block deal records live-verified,
    # a materially richer feed than what block_deal_fetcher.py's NSE-sourced daily pull captures.
    EndpointDefinition(
        name="tickertape_deals",
        url_template="https://analyze.api.tickertape.in/stocks/deals",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="Tickertape",
        category="Ownership & Institutional Holdings",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="trendlyne_market_insight",
        url_template="https://trendlyne.com/equity/api/market-insight/",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="Trendlyne",
        category="News, Filings & AI Sentiment",
        enabled=True,
        parser_ready=True,
    ),
    EndpointDefinition(
        name="trendlyne_mf_home",
        url_template="https://trendlyne.com/mutual-fund/getMFhome/",
        scope="market",
        required_ids=(),
        source="curated_extra",
        provider="Trendlyne",
        category="General Market Metadata",
        enabled=True,
        parser_ready=True,
    ),
)


def ensure_endpoint_registry_schema(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_endpoint_registry (
            endpoint_name TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            raw_id TEXT,
            provider TEXT,
            category TEXT,
            scope TEXT NOT NULL,
            http_method TEXT NOT NULL,
            data_format TEXT NOT NULL,
            url_template TEXT NOT NULL,
            required_ids_json TEXT NOT NULL,
            feature_targets_json TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            parser_ready INTEGER NOT NULL DEFAULT 0,
            validation_status TEXT NOT NULL,
            validation_errors_json TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def sync_registry_to_db(cur, entries: list[EndpointDefinition]) -> int:
    ensure_endpoint_registry_schema(cur)
    cur.execute(
        "DELETE FROM ai_endpoint_registry WHERE source IN (?, ?)",
        ("curated_extra", "ai_memory"),
    )
    now = datetime.now().isoformat()
    for entry in entries:
        cur.execute(
            """
            INSERT INTO ai_endpoint_registry (
                endpoint_name, source, raw_id, provider, category, scope,
                http_method, data_format, url_template, required_ids_json,
                feature_targets_json, enabled, parser_ready, validation_status,
                validation_errors_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                entry.name,
                entry.source,
                entry.raw_id,
                entry.provider,
                entry.category,
                entry.scope,
                entry.http_method,
                entry.data_format,
                entry.url_template,
                entry.required_ids_json(),
                entry.feature_targets_json(),
                1 if entry.enabled else 0,
                1 if entry.parser_ready else 0,
                entry.validation_status,
                entry.validation_errors_json(),
                now,
            ),
        )
    return len(entries)


def load_endpoint_registry(
    memory_path: str | os.PathLike[str] | None = None,
    reference_path: str | os.PathLike[str] | list[str | os.PathLike[str]] | None = None,
) -> list[EndpointDefinition]:
    entries = list(CURATED_EXTRA_ENDPOINTS)
    reference_index = load_reference_value_index(reference_path)
    entries.extend(load_ai_memory_endpoints(memory_path or DEFAULT_MEMORY_PATH, reference_index))
    return entries


def load_ai_memory_endpoints(
    path: str | os.PathLike[str],
    reference_index: ReferenceValueIndex | None = None,
) -> list[EndpointDefinition]:
    memory_path = Path(path)
    if not memory_path.exists():
        return [
            EndpointDefinition(
                name="ai_memory_catalog_missing",
                url_template=str(memory_path),
                scope="unknown",
                required_ids=(),
                source="ai_memory",
                provider="unknown",
                category="unknown",
                enabled=False,
                parser_ready=False,
                validation_status="invalid",
                validation_errors=("memory_file_missing",),
            )
        ]

    try:
        records = json.loads(memory_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [
            EndpointDefinition(
                name="ai_memory_catalog_unreadable",
                url_template=str(memory_path),
                scope="unknown",
                required_ids=(),
                source="ai_memory",
                provider="unknown",
                category="unknown",
                enabled=False,
                parser_ready=False,
                validation_status="invalid",
                validation_errors=(f"memory_file_unreadable:{type(exc).__name__}",),
            )
        ]

    if not isinstance(records, list):
        return [
            EndpointDefinition(
                name="ai_memory_catalog_invalid_shape",
                url_template=str(memory_path),
                scope="unknown",
                required_ids=(),
                source="ai_memory",
                provider="unknown",
                category="unknown",
                enabled=False,
                parser_ready=False,
                validation_status="invalid",
                validation_errors=("memory_file_not_list",),
            )
        ]

    return [
        validate_ai_memory_record(record, idx, reference_index)
        for idx, record in enumerate(records, start=1)
    ]


def load_reference_value_index(path: str | os.PathLike[str] | None = None) -> ReferenceValueIndex:
    index = ReferenceValueIndex()
    for reference_path in _reference_paths(path):
        if not reference_path.exists():
            continue
        for url, provider in _read_reference_urls(reference_path):
            index.add_url(url, provider)
    return index


def validate_ai_memory_record(
    record: dict[str, Any],
    ordinal: int,
    reference_index: ReferenceValueIndex | None = None,
) -> EndpointDefinition:
    if not isinstance(record, dict):
        return EndpointDefinition(
            name=f"ai_memory_row_{ordinal:04d}",
            url_template="",
            scope="unknown",
            required_ids=(),
            source="ai_memory",
            provider="unknown",
            category="unknown",
            enabled=False,
            parser_ready=False,
            validation_status="invalid",
            validation_errors=("row_not_object",),
        )

    raw_id = str(record.get("id") or f"ROW-{ordinal:04d}")
    provider = str(record.get("provider") or "unknown")
    category = str(record.get("category") or "unknown")
    method = str(record.get("http_method") or "GET").upper()
    data_format = str(record.get("data_format") or "JSON").upper()
    url = str(record.get("url") or "")
    errors: list[str] = []

    if not raw_id:
        errors.append("missing_id")
    if method != "GET":
        errors.append("unsupported_method")
    if data_format not in {"JSON", "TEXT"}:
        errors.append("unsupported_data_format")

    template_url, required_ids, url_errors = _template_memory_url(url, provider, reference_index)
    errors.extend(url_errors)
    scope = "stock" if required_ids else "market"

    status = "invalid" if errors else "valid"
    return EndpointDefinition(
        name=f"ai_memory_{raw_id}",
        url_template=template_url,
        scope=scope,
        required_ids=tuple(sorted(required_ids)),
        source="ai_memory",
        provider=provider,
        category=category,
        http_method=method,
        data_format=data_format,
        feature_targets=tuple(str(x) for x in record.get("harmonizedFields") or []),
        raw_id=raw_id,
        enabled=False,
        parser_ready=False,
        validation_status=status,
        validation_errors=tuple(sorted(set(errors))),
    )


def get_fetchable_endpoints(
    entries: list[EndpointDefinition],
    include_unparsed_memory: bool = False,
) -> tuple[list[EndpointDefinition], list[EndpointDefinition]]:
    fetchable = []
    for entry in entries:
        can_fetch = entry.enabled and entry.validation_status == "valid"
        if entry.source == "ai_memory" and include_unparsed_memory:
            can_fetch = entry.validation_status == "valid"
        if not can_fetch:
            continue
        if not entry.parser_ready and not include_unparsed_memory:
            continue
        fetchable.append(entry)
    stock = [e for e in fetchable if e.scope == "stock"]
    market = [e for e in fetchable if e.scope == "market"]
    return stock, market


def render_endpoint_url(endpoint: EndpointDefinition, stock: dict[str, Any] | None = None) -> str | None:
    values = stock or {}
    missing = [field for field in endpoint.required_ids if not values.get(field)]
    if missing:
        return None
    try:
        return endpoint.url_template.format(**values)
    except KeyError:
        return None


def registry_summary(entries: list[EndpointDefinition]) -> dict[str, int]:
    return {
        "total": len(entries),
        "curated": sum(1 for e in entries if e.source == "curated_extra"),
        "ai_memory": sum(1 for e in entries if e.source == "ai_memory"),
        "valid": sum(1 for e in entries if e.validation_status == "valid"),
        "fetchable": sum(1 for e in entries if e.enabled and e.parser_ready and e.validation_status == "valid"),
    }


def _template_memory_url(
    url: str,
    provider: str | None = None,
    reference_index: ReferenceValueIndex | None = None,
) -> tuple[str, set[str], list[str]]:
    errors: list[str] = []
    required_ids: set[str] = set()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        errors.append("invalid_scheme")
    if not parsed.netloc:
        errors.append("missing_host")

    endpoint_sample_values = reference_index.sample_query_values(provider, url) if reference_index else {}
    query_parts = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        normalized_value = value.strip()
        field = STOCK_FIELD_PARAMS.get(key)
        if field and normalized_value:
            normalized_value = "{" + field + "}"
            required_ids.add(field)
        elif normalized_value.lower() == "default":
            sample_value = endpoint_sample_values.get(key)
            if sample_value is None and reference_index:
                sample_value = reference_index.sample_value(provider, url, key)
            if sample_value is not None:
                normalized_value = sample_value
            else:
                errors.append("default_placeholder")
        query_parts.append((_quote_query_part(key), _quote_query_part(normalized_value)))

    query = "&".join(f"{key}={value}" for key, value in query_parts)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment)), required_ids, errors


def _only_value(counter: Counter[str] | None) -> str | None:
    if not counter or len(counter) != 1:
        return None
    return next(iter(counter))


def _reference_paths(
    path: str | os.PathLike[str] | list[str | os.PathLike[str]] | None,
) -> list[Path]:
    if path is None:
        return list(DEFAULT_REFERENCE_PATHS)
    if isinstance(path, (list, tuple)):
        return [Path(p) for p in path if p]
    text = str(path)
    if not text:
        return list(DEFAULT_REFERENCE_PATHS)
    return [Path(part) for part in text.split(os.pathsep) if part]


def _read_reference_urls(path: Path) -> list[tuple[str, str | None]]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json" or text.lstrip().startswith("["):
        try:
            records = json.loads(text)
        except Exception:
            return []
        if not isinstance(records, list):
            return []
        urls: list[tuple[str, str | None]] = []
        for record in records:
            if isinstance(record, dict) and isinstance(record.get("url"), str):
                urls.append((record["url"], str(record.get("provider") or "")))
            elif isinstance(record, str):
                urls.append((record, None))
        return urls

    urls = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        urls.append((stripped, None))
    return urls


def _normalize_path(path: str) -> str:
    return "/" + "/".join(part for part in path.lower().split("/") if part)


def _path_name(path: str) -> str:
    normalized = _normalize_path(path)
    if normalized == "/":
        return "/"
    return normalized.rsplit("/", 1)[-1]


def _provider_key(provider: str | None) -> str:
    return (provider or "").strip().lower()


def _quote_query_part(value: str) -> str:
    return quote(value, safe="{}:,/;")
