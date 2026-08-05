"""Live-datasource test for mf_stock_holdings_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). Distinct from mf_holdings_fetcher.py (per-fund portfolios) --
this is the per-stock MF ownership-flow axis (net share change, funds adding/trimming).
"""
import os

import sqlite3
import sys
from datetime import date

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mf_stock_holdings_fetcher as msh
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


def _make_test_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE technical_signals (
        symbol TEXT, date TEXT,
        mf_net_share_chg_pct REAL, mf_fund_count INTEGER,
        mf_funds_adding INTEGER, mf_funds_trimming INTEGER,
        mf_add_trim_ratio REAL, mf_avg_pct_assets REAL, mf_big_fund_flow REAL
    )""")
    today = date.today().isoformat()
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (REAL_SYMBOL, today))
    conn.commit()
    msh.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestMfStockHoldingsFetcherLiveDataSource:
    def test_real_fetch_and_aggregate_produce_ml_usable_data(self):
        """Hits the real ET Markets per-stock MF-holdings endpoint for RELIANCE via the
        fetcher's own fetch_holdings_pages(), aggregated with its own aggregate()."""
        from et_stats_client import load_companyid_map
        companyid_map = load_companyid_map()
        company_id = companyid_map.get(REAL_SYMBOL)
        assert company_id, f"{REAL_SYMBOL} not found in the companyid map -- fixture stale?"

        session = requests.Session()
        data = msh.fetch_holdings_pages(company_id, session)
        assert data is not None, "fetch_holdings_pages() returned None for RELIANCE -- endpoint may be down/changed"
        assert data.get("searchresult"), "no per-fund holding rows returned for RELIANCE, a large well-covered stock"

        agg = msh.aggregate(data["searchresult"], data.get("totalRecords"))
        assert agg is not None, "aggregate() returned None for a non-empty real fund list"
        assert agg["as_of_date"], "aggregate() couldn't determine an as_of_date from real fund rows"
        assert_numeric_and_finite(agg["num_funds"], context="agg.num_funds")
        assert agg["num_funds"] > 0

    def test_process_stock_writes_ml_usable_rows(self):
        """Runs the fetcher's real process_stock() end-to-end for RELIANCE (real fetch,
        real aggregate, real write via its own upsert()/stamp_technical_signals()) into a
        throwaway DB."""
        from et_stats_client import load_companyid_map
        companyid_map = load_companyid_map()
        company_id = companyid_map.get(REAL_SYMBOL)
        assert company_id, f"{REAL_SYMBOL} not found in the companyid map -- fixture stale?"

        conn = _make_test_conn()
        session = requests.Session()
        agg = msh.process_stock(REAL_SYMBOL, company_id, session, conn)
        assert agg is not None, "process_stock() returned None for RELIANCE despite real per-fund data existing"

        row = conn.execute(
            "SELECT symbol, as_of_date, num_funds, net_share_chg_pct FROM mf_stock_holdings WHERE symbol = ?",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "process_stock() reported success but wrote no row to mf_stock_holdings"
        assert_looks_like_ticker(row["symbol"], context="mf_stock_holdings.symbol")
        assert row["as_of_date"], "mf_stock_holdings.as_of_date is empty"
        assert_numeric_and_finite(row["num_funds"], context="mf_stock_holdings.num_funds")
        conn.close()
