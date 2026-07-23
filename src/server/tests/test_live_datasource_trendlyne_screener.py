"""
Concrete live_datasource test for trendlyne_screener_discovery.py — the fetcher
root-caused as the source of the 2026-07-23 URL-as-symbol corruption (~2.1M rows
across confluence_signals/unified_recommendations/stock_scores/etc). This is the
worked example for the pattern documented in CLAUDE.md's "Adding a new data source" rule.

Screener PK 42221 ("FII/FPI decreasing shareholding") is a real, long-lived Trendlyne
screener with 190+ stocks in production as of 2026-07-23 — chosen because it's unlikely to
disappear, not because it's special in any other way.
"""

import sqlite3
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from trendlyne_screener_discovery import fetch_screener, extract_screener_info, upsert_screener
from live_datasource_helpers import (
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_stored_row_ml_usable,
)

REAL_SCREENER_PK = 42221


def _make_test_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE trendlyne_screeners (
            screener_id TEXT PRIMARY KEY, screener_name TEXT, screenpk INTEGER,
            description TEXT, sentiment TEXT, category TEXT, timeframe TEXT,
            last_updated TEXT, screener_url TEXT, query_text TEXT, stock_count INTEGER
        );
        CREATE TABLE screener_master (
            scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT,
            inferred_timeframe TEXT, confidence REAL
        );
        CREATE TABLE screener_catalog (
            screener_id TEXT PRIMARY KEY, source TEXT, screener_name TEXT,
            category TEXT, subcategory TEXT, signal_bias TEXT,
            investment_horizon TEXT, confidence REAL, signal_keywords TEXT,
            screener_url TEXT
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT, stock_id TEXT, symbol TEXT,
            first_seen TEXT, last_seen TEXT,
            PRIMARY KEY (screener_id, stock_id)
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestTrendlyneScreenerLiveDataSource:
    def test_real_screener_returns_real_tickers_not_urls(self):
        """Step 1-3 of the pattern: hit the real URL, parse with the real function,
        assert the response is non-empty and every extracted symbol looks like a ticker."""
        data = fetch_screener(REAL_SCREENER_PK)
        assert_non_empty_response(data, f"fetch_screener({REAL_SCREENER_PK})")

        info = extract_screener_info(REAL_SCREENER_PK, data)
        assert info is not None, "extract_screener_info returned None for a known-good screener"
        assert_non_empty_response(info["stocks"], f"extract_screener_info({REAL_SCREENER_PK})['stocks']")

        for sym in info["stocks"]:
            assert_looks_like_ticker(sym, f"screener {REAL_SCREENER_PK} stock symbol")

    def test_real_screener_stores_ml_usable_rows(self):
        """Step 4-5 of the pattern: write through the real DB-write function into a
        throwaway DB, then read the stored rows back and validate they're ML-usable —
        catches both parsing bugs and storage/type-coercion bugs."""
        data = fetch_screener(REAL_SCREENER_PK)
        info = extract_screener_info(REAL_SCREENER_PK, data)
        assert info is not None

        conn = _make_test_db()
        upsert_screener(conn, info)
        # Matches production's own upsert shape (trendlyne_screener_discovery.py's main sync
        # loop) — ON CONFLICT DO UPDATE because the same symbol can legitimately appear more
        # than once in a screener's row list.
        for sym in info["stocks"]:
            conn.execute(
                "INSERT INTO trendlyne_screener_stocks (screener_id, stock_id, symbol, first_seen, last_seen) "
                "VALUES (?, ?, ?, date('now'), date('now')) "
                "ON CONFLICT(screener_id, stock_id) DO UPDATE SET symbol = excluded.symbol, last_seen = excluded.last_seen",
                (info["screener_id"], sym, sym),
            )
        conn.commit()

        screener_row = conn.execute(
            "SELECT * FROM trendlyne_screeners WHERE screenpk = ?", (REAL_SCREENER_PK,)
        ).fetchone()
        assert screener_row is not None, "screener metadata was not stored"
        assert_stored_row_ml_usable(
            dict(screener_row),
            numeric_cols=["stock_count"],
            ticker_cols=[],
            context="trendlyne_screeners",
        )

        stock_rows = conn.execute(
            "SELECT * FROM trendlyne_screener_stocks WHERE screener_id = ?", (info["screener_id"],)
        ).fetchall()
        distinct_symbols = len(set(info["stocks"]))
        assert len(stock_rows) == distinct_symbols, \
            f"expected {distinct_symbols} distinct stored stock rows, got {len(stock_rows)}"
        for row in stock_rows:
            assert_stored_row_ml_usable(
                dict(row), numeric_cols=[], ticker_cols=["symbol"], context="trendlyne_screener_stocks",
            )
