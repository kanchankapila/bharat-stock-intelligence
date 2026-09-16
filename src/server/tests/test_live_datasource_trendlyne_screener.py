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
from pg_test_support import pg_memory_conn  # noqa: E402
from trendlyne_screener_discovery import fetch_screener, extract_screener_info, upsert_screener
from live_datasource_helpers import (
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_stored_row_ml_usable,
)

REAL_SCREENER_PK = 42221


def _make_test_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE trendlyne_screeners (
            screener_id TEXT PRIMARY KEY, screener_name TEXT, screenpk INTEGER,
            description TEXT, sentiment TEXT, category TEXT, timeframe TEXT,
            last_updated TEXT, screener_url TEXT, query_text TEXT, stock_count INTEGER
        );
        CREATE TABLE screener_master (
            scan_id TEXT, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT,
            inferred_timeframe TEXT, confidence DOUBLE PRECISION,
            -- last_updated is written by upsert_screener_master() and EXISTS in production and
            -- in db/schema.postgres.sql; it was simply missing here. Before the search_path
            -- isolation fix an unqualified write fell through to public.screener_master, i.e.
            -- PRODUCTION, so the omission was invisible.
            last_updated TIMESTAMPTZ,
            UNIQUE (source, scan_id)
        );
        -- Mirrors production's column list (checked against information_schema, not guessed).
        -- score_0_100/tier/sub_mod/horiz_mult/fetched_at were all missing; the writer sets
        -- fetched_at, so the UPDATE failed. Same cause as screener_master above -- before the
        -- search_path isolation fix these writes fell through to the PRODUCTION table.
        CREATE TABLE screener_catalog (
            screener_id TEXT PRIMARY KEY, source TEXT, screener_name TEXT,
            category TEXT, subcategory TEXT, signal_bias TEXT,
            investment_horizon TEXT, confidence DOUBLE PRECISION,
            score_0_100 DOUBLE PRECISION, tier TEXT,
            sub_mod DOUBLE PRECISION, horiz_mult DOUBLE PRECISION,
            signal_keywords TEXT, screener_url TEXT, fetched_at TEXT
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT, stock_id TEXT, symbol TEXT,
            first_seen TEXT, last_seen TEXT,
            PRIMARY KEY (screener_id, stock_id)
        );
        -- Added by migration 1787100000000 after upsert_screener() started writing to it
        -- (screener-pk-collision fix, trendlyne_screener_discovery.py) -- missing here left
        -- this test failing with "relation does not exist" against a genuinely-empty throwaway
        -- schema, easily misread as a production gap since production has carried this table
        -- since 2026-08-18. Mirrors db/schema.postgres.sql's real column list.
        CREATE TABLE trendlyne_screener_pk_history (
            screener_id TEXT NOT NULL, screenpk TEXT NOT NULL,
            first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (screener_id, screenpk)
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
