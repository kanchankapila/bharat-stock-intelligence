"""Live-datasource test for mf_holdings_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule).

HISTORY: the original source here (mfapps.indiatimes.com's MFPortfolioHolding.cms) was
found dead by an earlier version of this test (bare 404 for every symbol/bse-code/nse-code
combination, flagged rather than silently worked around per the feedback_failing_urls
convention). Independently rediscovered 2026-08-13 during a fetcher-accuracy-review sweep
(the table it fed had never been created in production) and fixed the same day: repointed
at ET's shareholding-pattern endpoint (marketservices.indiatimes.com), keyed by the
standard ET companyid instead of bse/nse codes. This test now exercises the real, working
path -- no more graceful skip.
"""
import os
import sqlite3
import sys
from datetime import date

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import mf_holdings_fetcher as mhf
from et_stats_client import load_companyid_map
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


def _make_test_conn():
    conn = pg_memory_conn()
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
    def test_real_fetch_returns_ml_usable_holding_pct(self):
        company_map = load_companyid_map()
        company_id = company_map.get(REAL_SYMBOL)
        assert company_id, f"{REAL_SYMBOL} not found in the companyid map — fixture stale?"

        session = requests.Session()
        session.headers.update(mhf.HEADERS)
        result = mhf.fetch_mf_holding(REAL_SYMBOL, company_id, session)
        assert result is not None, (
            f"fetch_mf_holding returned None for {REAL_SYMBOL} — either the endpoint changed "
            f"shape again or companyId={company_id} is stale"
        )
        assert result["symbol"] == REAL_SYMBOL
        assert_numeric_and_finite(result["mf_holding_pct"], context="mf_holding_pct")
        assert 0 <= result["mf_holding_pct"] <= 100, f"mf_holding_pct out of range: {result['mf_holding_pct']}"
        assert result.get("as_of_date"), "as_of_date missing — point-in-time gating needs this"

    def test_upsert_writes_ml_usable_rows_and_point_in_time_gates_correctly(self):
        company_map = load_companyid_map()
        company_id = company_map.get(REAL_SYMBOL)
        session = requests.Session()
        session.headers.update(mhf.HEADERS)
        result = mhf.fetch_mf_holding(REAL_SYMBOL, company_id, session)
        assert result is not None, f"fetch_mf_holding returned None for {REAL_SYMBOL}"

        conn = _make_test_conn()
        today = date.today().isoformat()
        mhf.upsert_holdings([result], today, conn)

        row = conn.execute(
            "SELECT symbol, mf_holding_pct FROM stock_mf_holdings WHERE symbol = ?",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "upsert_holdings() wrote no row to stock_mf_holdings"
        assert_looks_like_ticker(row["symbol"], context="stock_mf_holdings.symbol")
        assert_numeric_and_finite(row["mf_holding_pct"], context="stock_mf_holdings.mf_holding_pct")

        # The technical_signals seed row above is dated "today", and the real disclosure this
        # test just fetched is always from a PAST quarter -- so floor (quarter-end + 30d) should
        # already be behind today, and the write should land, not get NULLed by the gate.
        ts_row = conn.execute(
            "SELECT mf_holding_pct FROM technical_signals WHERE symbol = ? AND date = ?",
            (REAL_SYMBOL, today),
        ).fetchone()
        assert ts_row is not None and ts_row["mf_holding_pct"] is not None, (
            "upsert_holdings() didn't backfill technical_signals.mf_holding_pct — check "
            "_floor()'s epoch-ms parsing of quarterDates[0] against the real response shape"
        )
        conn.close()
