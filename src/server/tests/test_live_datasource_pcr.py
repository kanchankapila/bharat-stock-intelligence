"""Live-datasource test for pcr_fetcher.py (see CLAUDE.md's "Adding a new data source"
mandatory rule). One of the ~130 previously-untested fetchers flagged in the 2026-07-30
fifth full-stack-audit pass. NiftyTrader is the primary source here (NSE's own option-chain
API is Akamai-walled) — this test hits the real NiftyTrader endpoint via the fetcher's own
fetch_symbol_niftytrader()/parse_niftytrader_chain(), not a hand-rolled reimplementation.
"""
import os
import sys

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pcr_fetcher import PCRFetcher
from live_datasource_helpers import assert_non_empty_response, assert_looks_like_ticker, assert_stored_row_ml_usable

REAL_SYMBOL = "RELIANCE"


def _make_test_engine():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE stock_options_oi (
                symbol TEXT, date TEXT, expiry TEXT, call_oi REAL, put_oi REAL, pcr REAL,
                total_call_oi REAL, total_put_oi REAL, market_pcr REAL, atm_iv REAL,
                iv_skew REAL, fetched_at TEXT,
                PRIMARY KEY (symbol, date, expiry)
            )
        """))
        conn.execute(text("""
            CREATE TABLE historical_fno_sentiment (
                symbol TEXT, date TEXT, pcr_oi REAL, pcr_vol REAL, max_pain REAL,
                atm_iv REAL, iv_skew REAL, total_ce_oi REAL, total_pe_oi REAL, updated_at TEXT,
                PRIMARY KEY (symbol, date)
            )
        """))
    return engine


@pytest.mark.live_datasource
class TestPcrFetcherLiveDataSource:
    def test_real_fetch_returns_ml_usable_chain(self):
        """Step 1-3: hit the real NiftyTrader endpoint, parse with the fetcher's own
        parse_niftytrader_chain(), assert non-empty and OI/PCR fields are usable numbers."""
        fetcher = PCRFetcher()
        rec = fetcher.fetch_symbol_niftytrader(REAL_SYMBOL)
        assert_non_empty_response(rec, f"fetch_symbol_niftytrader({REAL_SYMBOL})")

        assert_looks_like_ticker(rec["symbol"], "pcr record symbol")
        assert isinstance(rec["total_call_oi"], (int, float)) and rec["total_call_oi"] >= 0, \
            f"total_call_oi not a usable non-negative number: {rec['total_call_oi']!r}"
        assert isinstance(rec["total_put_oi"], (int, float)) and rec["total_put_oi"] >= 0, \
            f"total_put_oi not a usable non-negative number: {rec['total_put_oi']!r}"
        assert rec["expiry"], "expiry date missing from parsed chain"

    def test_real_fetch_stores_ml_usable_row(self):
        """Step 4-5: write through the fetcher's own save() into a throwaway SQLite engine
        (swapped in for fetcher.engine), then read the rows back from both tables it writes
        and validate they're ML-usable."""
        fetcher = PCRFetcher()
        rec = fetcher.fetch_symbol_niftytrader(REAL_SYMBOL)
        assert_non_empty_response(rec, f"fetch_symbol_niftytrader({REAL_SYMBOL})")

        fetcher.engine = _make_test_engine()
        saved = fetcher.save([rec])
        assert saved == 1, f"expected 1 row saved, got {saved}"

        with fetcher.engine.connect() as conn:
            oi_row = conn.execute(text("SELECT * FROM stock_options_oi WHERE symbol = :s"),
                                   {"s": REAL_SYMBOL}).mappings().first()
            sentiment_row = conn.execute(text("SELECT * FROM historical_fno_sentiment WHERE symbol = :s"),
                                          {"s": REAL_SYMBOL}).mappings().first()
        assert oi_row is not None, "no row landed in stock_options_oi after save()"
        assert sentiment_row is not None, "no row landed in historical_fno_sentiment after save()"

        assert_stored_row_ml_usable(
            dict(oi_row), numeric_cols=["total_call_oi", "total_put_oi"],
            ticker_cols=["symbol"], context="stock_options_oi",
        )
        assert_stored_row_ml_usable(
            dict(sentiment_row), numeric_cols=["total_ce_oi", "total_pe_oi"],
            ticker_cols=["symbol"], context="historical_fno_sentiment",
        )
