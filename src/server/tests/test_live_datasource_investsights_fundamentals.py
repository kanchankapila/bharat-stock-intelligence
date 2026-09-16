"""Live-datasource test for investsights_fundamentals_fetcher.py
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

import investsights_fundamentals_fetcher as fu
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable


def _session():
    s = requests.Session()
    s.headers.update(fu.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsFundamentalsLiveDataSource:
    def test_real_ttm_fetch_has_income_statement(self):
        payload = fu.fetch_ttm(_session(), "RELIANCE")
        assert_non_empty_response(payload, "fetch_ttm(RELIANCE)")
        assert payload.get("income_statement"), "ttm response missing income_statement"

    def test_real_fmp_ratios_has_piotroski_and_altman(self):
        data = fu.fetch_fmp_ratios(_session(), "RELIANCE")
        assert_non_empty_response(data, "fetch_fmp_ratios(RELIANCE)")
        assert data.get("piotroski_score") is not None
        assert data.get("pe_ratio") is not None

    def test_real_dcf_valuation_has_stock_price(self):
        data = fu.fetch_dcf(_session(), "RELIANCE")
        assert_non_empty_response(data, "fetch_dcf(RELIANCE)")
        assert data.get("stock_price"), "dcf-valuation missing stock_price"

    def test_stored_row_is_ml_usable(self):
        session = _session()
        ttm = fu.fetch_ttm(session, "RELIANCE")
        fmp = fu.fetch_fmp_ratios(session, "RELIANCE")
        growth = fu.fetch_growth_metrics(session, "RELIANCE")
        dcf = fu.fetch_dcf(session, "RELIANCE")
        row = fu.parse_row("RELIANCE", "2026-08-13", ttm, fmp, growth, dcf)
        assert row is not None

        con = pg_memory_conn()
        fu.ensure_schema(con)
        assert fu.store_row(con, row) == 1

        cur = con.execute(
            "SELECT symbol, pe_ratio, piotroski_score, dcf_stock_price "
            "FROM investsights_fundamentals_history LIMIT 1"
        )
        cols = [d[0] for d in cur.description]
        stored = dict(zip(cols, cur.fetchone()))
        assert_stored_row_ml_usable(
            stored, numeric_cols=["pe_ratio", "piotroski_score", "dcf_stock_price"],
            ticker_cols=["symbol"], context="investsights_fundamentals_history",
        )
