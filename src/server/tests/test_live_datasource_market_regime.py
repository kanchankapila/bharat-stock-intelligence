"""Live-datasource test for market_regime_fetcher.py (see CLAUDE.md's "Adding a New Data
Source" mandatory rule).

This fetcher feeds `macro_asset_prices` (registered `critical: true` in
dataQualityChecks.ts's TABLE_FRESHNESS_CHECKS), which in turn feeds the regime detector that
gates `unified_ranker.py`'s entire REGIME_WEIGHTS blend -- a bad or silently-stale VIX/USDINR
reading here doesn't just corrupt one column, it can mis-select which of the 5 regime weight
sets the whole platform blends under. No `live_datasource` test existed for it before this.

VIX comes from NSE (session-warmed, no stored token); USDINR comes from MoneyControl via
curl_cffi TLS impersonation (no stored token either) -- confirmed by reading both fetch
functions before writing this.
"""
import datetime
import os
import sys

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import market_regime_fetcher as mrf
from live_datasource_helpers import assert_numeric_and_finite


@pytest.mark.live_datasource
class TestMarketRegimeLiveDataSource:
    def test_real_vix_fetch_is_ml_usable(self):
        """Step 1-3: hit the real NSE allIndices endpoint, parse with the fetcher's own
        fetch_vix(), assert the value is a real, plausible, finite number."""
        session = mrf._nse_session()
        vix = mrf.fetch_vix(session)
        assert vix is not None, "fetch_vix() returned None -- live NSE VIX fetch failed"
        assert_numeric_and_finite(vix, context="market_regime_fetcher VIX")
        # fetch_vix() itself already sanity-checks 5 < vix < 100 and returns None outside that
        # range -- re-asserting it here pins the contract rather than trusting it silently.
        assert 5.0 < vix < 100.0, f"India VIX {vix} outside the fetcher's own plausible range"

    def test_real_usdinr_fetch_is_ml_usable(self):
        """Step 1-3: hit the real MoneyControl currency endpoint, parse with the fetcher's
        own fetch_usdinr(), assert both fields are real, plausible, finite numbers."""
        rate, chg_pct = mrf.fetch_usdinr()
        assert rate is not None, "fetch_usdinr() returned None rate -- live MC fetch failed"
        assert_numeric_and_finite(rate, context="market_regime_fetcher USDINR rate")
        # USD/INR has traded roughly 70-105 across any plausible recent regime -- catches a
        # parse landing on the wrong JSON field (e.g. a % change value mistaken for the rate).
        assert 50.0 < rate < 150.0, f"USDINR rate {rate} outside any plausible historical range"
        if chg_pct is not None:
            assert_numeric_and_finite(chg_pct, context="market_regime_fetcher USDINR chg_pct")

    def test_real_fetch_writes_ml_usable_rows(self):
        """Step 4-5: write real VIX + USDINR data through the fetcher's own
        _save_macro_rows() into a throwaway in-memory SQLite engine (it takes a SQLAlchemy
        `engine` parameter directly -- no monkeypatching needed), then read the rows back and
        assert they are ML-usable: real symbol keys, real finite closes."""
        session = mrf._nse_session()
        vix = mrf.fetch_vix(session)
        rate, chg_pct = mrf.fetch_usdinr()
        assert vix is not None and rate is not None, "live fetch failed -- cannot exercise the write path"

        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as conn:
            conn.execute(text("""
                CREATE TABLE macro_asset_prices (
                    symbol TEXT NOT NULL,
                    date TEXT NOT NULL,
                    close REAL,
                    fetched_at TEXT,
                    PRIMARY KEY (symbol, date)
                )
            """))

        rows = [("INDIA_VIX", vix), ("USDINR_RATE", rate)]
        if chg_pct is not None:
            rows.append(("USDINR_CHG_PCT", chg_pct))
        mrf._save_macro_rows(engine, rows)

        today = datetime.date.today().isoformat()
        with engine.connect() as conn:
            stored = {
                r[0]: r[1]
                for r in conn.execute(text(
                    "SELECT symbol, close FROM macro_asset_prices WHERE date = :d"
                ), {"d": today}).fetchall()
            }

        assert "INDIA_VIX" in stored, "_save_macro_rows() did not persist the VIX row"
        assert "USDINR_RATE" in stored, "_save_macro_rows() did not persist the USDINR_RATE row"
        assert_numeric_and_finite(stored["INDIA_VIX"], context="macro_asset_prices round-trip INDIA_VIX")
        assert_numeric_and_finite(stored["USDINR_RATE"], context="macro_asset_prices round-trip USDINR_RATE")
