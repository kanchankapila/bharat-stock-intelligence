import json
import os
import sqlite3
import sys

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from pg_test_support import pg_memory_conn  # noqa: E402

from endpoint_registry import (  # noqa: E402
    CURATED_EXTRA_ENDPOINTS,
    ensure_endpoint_registry_schema,
    get_fetchable_endpoints,
    load_ai_memory_endpoints,
    load_endpoint_registry,
    load_reference_value_index,
    render_endpoint_url,
    sync_registry_to_db,
    validate_ai_memory_record,
)


def test_ai_memory_symbol_endpoint_is_templated_but_not_enabled():
    entry = validate_ai_memory_record(
        {
            "id": "EP-TEST",
            "url": "https://api.moneycontrol.com/mcapi/v1/live-quote?symbol=TCS",
            "description": "quote",
            "provider": "MoneyControl",
            "category": "Price & Technical Charts",
            "data_format": "JSON",
            "http_method": "GET",
            "parameters": ["symbol"],
            "harmonizedFields": ["last_price"],
        },
        1,
    )

    assert entry.validation_status == "valid"
    assert entry.url_template == "https://api.moneycontrol.com/mcapi/v1/live-quote?symbol={symbol}"
    assert entry.required_ids == ("symbol",)
    assert entry.enabled is False
    assert entry.parser_ready is False
    assert render_endpoint_url(entry, {"symbol": "INFY"}) == (
        "https://api.moneycontrol.com/mcapi/v1/live-quote?symbol=INFY"
    )


def test_ai_memory_default_placeholders_are_rejected(tmp_path):
    memory_path = tmp_path / "memory.json"
    memory_path.write_text(
        json.dumps(
            [
                {
                    "id": "EP-BAD",
                    "url": "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=TCS&resolution=default",
                    "provider": "MoneyControl",
                    "category": "Price & Technical Charts",
                    "data_format": "JSON",
                    "http_method": "GET",
                    "harmonizedFields": ["last_price"],
                }
            ]
        ),
        encoding="utf-8",
    )

    entries = load_ai_memory_endpoints(memory_path)

    assert len(entries) == 1
    assert entries[0].validation_status == "invalid"
    assert "default_placeholder" in entries[0].validation_errors


def test_reference_sample_fills_unambiguous_default_constants(tmp_path):
    reference_path = tmp_path / "urls_sample.json"
    reference_path.write_text(
        json.dumps(
            [
                {
                    "url": "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=BEL&resolution=1D&currencyCode=INR",
                    "description": "sample",
                }
            ]
        ),
        encoding="utf-8",
    )
    reference_index = load_reference_value_index(reference_path)

    entry = validate_ai_memory_record(
        {
            "id": "EP-SAMPLE",
            "url": "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=TCS&resolution=default&currencyCode=default",
            "provider": "MoneyControl",
            "category": "Price & Technical Charts",
            "data_format": "JSON",
            "http_method": "GET",
            "harmonizedFields": ["last_price"],
        },
        1,
        reference_index,
    )

    assert entry.validation_status == "valid"
    assert entry.required_ids == ("symbol",)
    assert entry.url_template.endswith("symbol={symbol}&resolution=1D&currencyCode=INR")


def test_txt_reference_sample_is_used_for_defaults(tmp_path):
    reference_path = tmp_path / "urls_sample.txt"
    reference_path.write_text(
        "https://api.example.test/screeners?pagesize=25&pageno=1&marketcap=\n",
        encoding="utf-8",
    )
    reference_index = load_reference_value_index(reference_path)

    entry = validate_ai_memory_record(
        {
            "id": "EP-TXT",
            "url": "https://api.example.test/screeners?pagesize=default&pageno=default&marketcap=default",
            "provider": "Example",
            "category": "Screener & Quantitative Discovery",
            "data_format": "JSON",
            "http_method": "GET",
        },
        1,
        reference_index,
    )

    assert entry.validation_status == "valid"
    assert entry.url_template.endswith("pagesize=25&pageno=1&marketcap=")


def test_same_url_txt_reference_replaces_defaults_as_group(tmp_path):
    reference_path = tmp_path / "urls_sample.txt"
    reference_path.write_text(
        "\n".join(
            [
                "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=BEL&resolution=1D&from=100&to=200&currencyCode=INR",
                "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=TCS&resolution=5&from=300&to=400&currencyCode=INR",
            ]
        ),
        encoding="utf-8",
    )
    reference_index = load_reference_value_index(reference_path)

    entry = validate_ai_memory_record(
        {
            "id": "EP-HISTORY",
            "url": "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=HDFCBANK&resolution=default&from=default&to=default&currencyCode=default",
            "provider": "MoneyControl",
            "category": "Price & Technical Charts",
            "data_format": "JSON",
            "http_method": "GET",
        },
        1,
        reference_index,
    )

    assert entry.validation_status == "valid"
    assert entry.url_template.endswith(
        "symbol={symbol}&resolution=1D&from=100&to=200&currencyCode=INR"
    )


def test_fetchable_registry_keeps_current_parser_ready_pipeline(tmp_path):
    memory_path = tmp_path / "memory.json"
    memory_path.write_text("[]", encoding="utf-8")

    stock_endpoints, market_endpoints = get_fetchable_endpoints(load_endpoint_registry(memory_path))
    stock = {"symbol": "BEL", "companyid": "123", "stockid": "456", "tickertape_sid": "BAJE"}
    rendered = {endpoint.name: render_endpoint_url(endpoint, stock) for endpoint in stock_endpoints}

    assert len(stock_endpoints) == 20
    assert len(market_endpoints) == 14
    assert rendered["marketservices_shareholding"].endswith("companyid=123")
    assert "sid=456" in rendered["trading80_header_info"]
    assert "sid=456" in rendered["marketsmojo_header_info"]
    assert rendered["investsights_score"] == "https://investsights.in/api/v2/stocks/BEL/score?"
    assert rendered["tapetide_score"] == "https://api.tapetide.com/api/v1/companies/BEL/score"
    assert rendered["tickertape_financials_income"] == (
        "https://api.tickertape.in/stocks/financials/income/BAJE/annual/normal"
    )


def test_registry_sync_persists_curated_and_memory_rows():
    con = pg_memory_conn()
    cur = con.cursor()
    entries = list(CURATED_EXTRA_ENDPOINTS) + [
        validate_ai_memory_record(
            {
                "id": "EP-OK",
                "url": "https://api.moneycontrol.com/mcapi/v1/live-quote?symbol=RELIANCE",
                "provider": "MoneyControl",
                "category": "Price & Technical Charts",
                "data_format": "JSON",
                "http_method": "GET",
                "harmonizedFields": ["last_price"],
            },
            1,
        )
    ]

    ensure_endpoint_registry_schema(cur)
    assert sync_registry_to_db(cur, entries) == len(entries)

    cur.execute(
        """
        SELECT source, enabled, parser_ready, validation_status, required_ids_json
        FROM ai_endpoint_registry
        WHERE endpoint_name = ?
        """,
        ("ai_memory_EP-OK",),
    )
    row = cur.fetchone()
    assert row == ("ai_memory", 0, 0, "valid", '["symbol"]')
