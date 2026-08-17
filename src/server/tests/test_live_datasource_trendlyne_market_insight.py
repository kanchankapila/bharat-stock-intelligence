"""Live-datasource test for trendlyne_market_insight_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import trendlyne_market_insight_fetcher as tmi
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response


@pytest.mark.live_datasource
class TestTrendlyneMarketInsightLiveDataSource:
    def test_real_fetch_returns_labeled_rows(self):
        rows = tmi.fetch_insights()
        assert_non_empty_response(rows, "fetch_insights()")
        r = rows[0]
        assert r.get("NSEcode"), "expected a real NSE ticker on every row"
        assert r.get("label"), "expected a real event label on every row"
        assert r.get("timeStamp")

    def test_stored_rows_are_ml_usable(self):
        universe = tmi.load_nse_universe()
        assert universe, "need a real nse_stocks universe to resolve symbols against"
        raw = tmi.fetch_insights()
        rows = [r for r in (tmi.parse_insight(i, universe) for i in raw) if r is not None]
        assert rows, "no usable (resolved-symbol, parseable-timestamp) rows in today's live sample"

        con = pg_memory_conn()
        tmi.ensure_schema(con)
        assert tmi.store(con, rows) == len(rows)

        symbol, label, event_time = con.execute(
            "SELECT symbol, label, event_time FROM trendlyne_market_insights LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        assert label
        assert len(event_time) == 19, f"event_time not 'YYYY-MM-DD HH:MM:SS' shaped: {event_time!r}"

    def test_symbol_match_rate_stays_high(self):
        """Live-verified 2026-08-15 at 95.5% (191/200) -- most misses are brand-new IPO
        listings not yet in nse_stocks. Guard against a silent collapse (e.g. a field rename
        upstream) rather than a specific threshold that would flake on IPO-heavy weeks."""
        universe = tmi.load_nse_universe()
        raw = tmi.fetch_insights()
        assert raw
        matched = sum(1 for i in raw if (i.get("NSEcode") or "").upper() in universe)
        rate = matched / len(raw)
        assert rate > 0.5, f"NSEcode match rate collapsed to {rate:.1%} -- check for a field rename upstream"
