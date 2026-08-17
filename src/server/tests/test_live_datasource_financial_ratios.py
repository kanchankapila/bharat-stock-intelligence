"""
live_datasource test for financial_ratios_fetcher.py (see .claude/rules/data-sources.md
"Adding a New Data Source"). Found missing 2026-08-13 during a full-project fetcher sweep:
test_financial_ratios_fetcher.py exercises compute_ratios() only against synthetic dicts,
never the real ET_Stats endpoint and never the DB-write path (upsert_quality/
update_technical_signals) -- exactly the gap CLAUDE.md's mandate exists to close.
test_live_datasource_et_stats.py already covers steps 1-3 (fetch + shape) for the shared
et_stats_client; this test's job is steps 3-4 for THIS fetcher specifically: its own
compute_ratios() parsing a real response, then its own write functions storing it, read
back and checked ML-usable -- the full fetch-through-storage round trip.
"""

import sqlite3
import sys
import os

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
from financial_ratios_fetcher import (  # noqa: E402
    HEADERS, _HARVEST_COLUMNS, compute_ratios, ensure_schema,
    upsert_quality, update_technical_signals,
)
from et_stats_client import fetch_et_stats, load_companyid_map  # noqa: E402
from live_datasource_helpers import assert_stored_row_ml_usable  # noqa: E402

# NOT HDFCBANK, despite that being this fetcher's own docstring's live-verified banking
# example: confirmed live 2026-08-13 that ET_Stats' Ratio payload for cType='Bank' names
# returns interestCoverage=None (by design -- banks' interest coverage isn't calculated the
# same way; the banking-appropriate substitute is nim/costToIncome, which ARE populated for
# HDFCBANK). interestCoverage is a "universal" harvest field per this fetcher's own docstring,
# so it needs a NonBank symbol to actually exercise.
REAL_SYMBOL = "RELIANCE"


def _throwaway_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)  # real tl_financial_quality DDL, not hand-duplicated
    # technical_signals isn't created by this fetcher (it's a shared platform table it only
    # UPDATEs), so build a minimal stand-in with exactly the columns update_technical_signals
    # touches -- derived from _HARVEST_COLUMNS, not hardcoded, so it can't drift from the real
    # write function's column list.
    cols = ["fcf_yield_approx", "interest_coverage", "fcf_positive", "debt_coverage_risk"] + _HARVEST_COLUMNS
    conn.execute(f"CREATE TABLE technical_signals (symbol TEXT, date TEXT, {', '.join(c + ' REAL' for c in cols)})")
    # update_technical_signals point-in-time-gates on date >= as_of_floor(year_ending) -- must
    # seed a row dated on/after "today" below, not an arbitrary past date, or the real gate
    # (correctly) NULLs the write and this looks like a bug that isn't one. Confirmed live:
    # RELIANCE's year_ending=2026-03-31 floors to 2026-06-29.
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (REAL_SYMBOL, "2026-08-13"))
    conn.commit()
    return conn


@pytest.mark.live_datasource
class TestFinancialRatiosLiveDataSource:
    def test_real_stock_computes_and_stores_ml_usable_ratios(self):
        company_map = load_companyid_map()
        company_id = company_map.get(REAL_SYMBOL)
        assert company_id, f"{REAL_SYMBOL} not found in the companyid map — fixture stale?"

        session = requests.Session()
        session.headers.update(HEADERS)
        cashflow = fetch_et_stats(company_id, "CashFlow", session, last=6)
        ratio = fetch_et_stats(company_id, "Ratio", session)
        assert cashflow, f"empty CashFlow response for {REAL_SYMBOL} (companyId={company_id})"
        assert ratio, f"empty Ratio response for {REAL_SYMBOL} (companyId={company_id})"

        # The fetcher's OWN parsing function, not a reimplementation.
        features = compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=1_000_000.0)
        assert features.get("interest_coverage") is not None, (
            "HDFCBANK should have a real interestCoverage figure from ET_Stats — "
            "None means either the endpoint or compute_ratios' field mapping broke"
        )

        conn = _throwaway_db()
        today = "2026-08-13"
        upsert_quality(REAL_SYMBOL, today, features, conn)
        update_technical_signals(REAL_SYMBOL, features, conn, today=today)

        quality_row = dict(conn.execute(
            "SELECT * FROM tl_financial_quality WHERE symbol = ? AND as_of_date = ?",
            (REAL_SYMBOL, today),
        ).fetchone())
        assert_stored_row_ml_usable(
            quality_row,
            numeric_cols=["interest_coverage"],
            ticker_cols=["symbol"],
            context="tl_financial_quality",
        )

        signals_row = dict(conn.execute(
            "SELECT * FROM technical_signals WHERE symbol = ?", (REAL_SYMBOL,),
        ).fetchone())
        assert signals_row["interest_coverage"] is not None, (
            "update_technical_signals wrote NULL for interest_coverage despite a real "
            "ET_Stats value being available -- check the as_of_floor() date-gate logic"
        )
        assert_stored_row_ml_usable(
            signals_row, numeric_cols=["interest_coverage"], ticker_cols=["symbol"],
            context="technical_signals",
        )
