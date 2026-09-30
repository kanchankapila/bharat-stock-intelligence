"""Live-datasource test for ndtv_profit_fetcher.py (CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
Every function goes through the module's own URL builder and parser. AF-20260930-21: two of the
four functions had returned nothing since they landed, and nothing noticed because none had a
live test.
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import ndtv_profit_fetcher as ndtv
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response

SYMBOL = "RELIANCE"  # F&O-eligible, so the summary and OI routes are defined for it


@pytest.mark.live_datasource
class TestNdtvProfitLiveDataSource:
    def test_stock_summary_is_real_json_with_finite_numbers(self):
        s = ndtv.fetch_stock_summary(SYMBOL)
        assert s is not None, "stock-summary returned nothing -- route changed or host blocked?"
        assert_looks_like_ticker(s["symbol"], "symbol")
        for k in ("spot_price", "open_interest", "pcr_oi"):
            assert s[k] is not None and math.isfinite(s[k]), f"{k}={s[k]!r}"
        assert s["spot_price"] > 0

    def test_open_interest_has_per_strike_calls_and_puts(self):
        df = ndtv.fetch_open_interest(SYMBOL)
        assert df is not None and len(df) > 5, "open-interest empty -- duration enum changed?"
        assert df["call_oi"].notna().any() and df["put_oi"].notna().any()
        assert (df["strike"].astype(float) > 0).all()

    def test_corporate_announcements(self):
        df = ndtv.fetch_corporate_announcements(SYMBOL)
        assert_non_empty_response(df if df is not None else [], "fetch_corporate_announcements")
        assert df["title"].notna().all()

    def test_market_news(self):
        df = ndtv.fetch_market_news(SYMBOL)
        assert_non_empty_response(df if df is not None else [], "fetch_market_news")
        assert df["title"].notna().all()
