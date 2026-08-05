"""Live-datasource test for mf_holdings_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule).

FINDING (this test, first run): the endpoint this fetcher calls --
mfapps.indiatimes.com/ET_Mutual_Funds/pages/mftools/MFPortfolioHolding.cms -- currently
returns a bare 404 for every symbol/bse-code/nse-code combination tried, including an
empty bsecode, RELIANCE's nse code, and RELIANCE's real BSE code (500325). The DOMAIN
itself is alive and serving other endpoints fine (mf_stock_holdings_fetcher.py's sibling
mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm returns 200 with real data) -- only
this specific path appears to have been retired/moved upstream. Per this repo's own
"when a data-source URL fails, report + ask for an alternative rather than researching one
myself" convention (see the feedback_failing_urls memory), this was NOT patched with a
guessed replacement URL here -- flagged to the user instead. This test asserts the current
real (broken) behavior -- fetch_mf_holding() returns None, not a crash -- so it will notice
if the endpoint is ever fixed or changes shape again.
"""
import os

import sqlite3
import sys
from datetime import date

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mf_holdings_fetcher as mhf
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


def _make_test_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE technical_signals (
        symbol TEXT, date TEXT,
        mf_holding_pct REAL, mf_fund_count INTEGER, mf_chg_vs_prev REAL
    )""")
    today = date.today().isoformat()
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (REAL_SYMBOL, today))
    conn.commit()
    mhf.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestMfHoldingsFetcherLiveDataSource:
    def test_real_fetch_current_state(self):
        """Hits the real MC/ET MFPortfolioHolding endpoint for RELIANCE via the fetcher's
        own fetch_mf_holding(). Currently returns None (confirmed 404 on the endpoint
        itself, independent of symbol/bse-code/nse-code) -- see module docstring. This
        assertion is deliberately conditional so the test both documents today's real
        broken state AND validates real data automatically the moment the endpoint is
        fixed upstream, without needing anyone to remember to update this test."""
        session = requests.Session()
        session.headers.update(mhf.HEADERS)
        result = mhf.fetch_mf_holding(REAL_SYMBOL, None, REAL_SYMBOL, session)
        if result is None:
            pytest.skip("mfapps.indiatimes.com/ET_Mutual_Funds/.../MFPortfolioHolding.cms "
                        "currently 404s for every input (confirmed independent of symbol) -- "
                        "see this file's module docstring; flagged, not silently worked around")
        assert result["symbol"] == REAL_SYMBOL
        assert_numeric_and_finite(result["mf_holding_pct"], context="mf_holding_pct")
        assert 0 <= result["mf_holding_pct"] <= 100, f"mf_holding_pct out of range: {result['mf_holding_pct']}"

    def test_upsert_writes_ml_usable_rows_when_endpoint_recovers(self):
        """Writes a real fetched RELIANCE holding through the fetcher's own
        upsert_holdings() into a throwaway DB -- only runs once the endpoint above starts
        returning real data again."""
        session = requests.Session()
        session.headers.update(mhf.HEADERS)
        result = mhf.fetch_mf_holding(REAL_SYMBOL, None, REAL_SYMBOL, session)
        if result is None:
            pytest.skip("endpoint currently broken (see test_real_fetch_current_state) -- "
                        "nothing real to exercise the write path with")

        conn = _make_test_conn()
        today = date.today().isoformat()
        mhf.upsert_holdings([result], today, conn)

        row = conn.execute(
            "SELECT symbol, mf_holding_pct, num_funds FROM stock_mf_holdings WHERE symbol = ?",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "upsert_holdings() wrote no row to stock_mf_holdings"
        assert_looks_like_ticker(row["symbol"], context="stock_mf_holdings.symbol")
        assert_numeric_and_finite(row["mf_holding_pct"], context="stock_mf_holdings.mf_holding_pct")

        ts_row = conn.execute(
            "SELECT mf_holding_pct FROM technical_signals WHERE symbol = ? AND date = ?",
            (REAL_SYMBOL, today),
        ).fetchone()
        assert ts_row is not None and ts_row["mf_holding_pct"] is not None, \
            "upsert_holdings() didn't backfill technical_signals.mf_holding_pct"
        conn.close()
