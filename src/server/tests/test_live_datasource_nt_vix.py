"""Live-datasource test for nt_vix_fetcher.py (see CLAUDE.md's "Adding a new data source"
mandatory rule). One of the ~115 remaining untested fetchers flagged in the 2026-08-04
"Audit backlog + live_datasource coverage" session — specifically one of the 4 nt_* NiftyTrader
fetchers flagged there as needing a monkeypatch-on-module-level-DB-functions pattern, since
(unlike mc_pricefeed_fetcher.py-style fetchers) execute()/executemany() are called as bare
module-level functions imported from db_compat, with no `con` parameter to inject a test DB
through.

India VIX / GIFT NIFTY spot data needs no auth (plain requests, no DB-stored Bearer token like
niftytraderService.ts's rotating token) -- confirmed by reading the fetcher before writing this.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nt_vix_fetcher as nvf
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable

REAL_NT_PARAM = "INDIA+VIX"
REAL_INDEX_NAME = "INDIAVIX"


class _CaptureDB:
    """Fakes db_compat's bare execute()/executemany() by recording (sql, params) calls
    instead of touching a real database -- the module-level-function equivalent of an
    in-memory sqlite conn for fetchers that don't accept a `con` parameter."""
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def executemany(self, sql, rows):
        for row in rows:
            self.calls.append((sql, row))


@pytest.mark.live_datasource
class TestNtVixLiveDataSource:
    def test_real_fetch_returns_ml_usable_spot_data(self):
        """Step 1-3: hit the real NiftyTrader spot endpoint for India VIX, parse with the
        fetcher's own fetch_spot(), assert the close/change fields are usable numbers."""
        data = nvf.fetch_spot(REAL_NT_PARAM)
        assert_non_empty_response(data, f"fetch_spot({REAL_NT_PARAM})")

        close = nvf._sf(data.get("last_trade_price")) or nvf._sf(data.get("close"))
        assert isinstance(close, float) and close > 0, \
            f"India VIX close not a usable positive number: {close!r}"
        # India VIX has a well-known plausible range (roughly 8-80 across any real regime,
        # including crash spikes) -- catches a parse landing on the wrong JSON field entirely.
        assert 5.0 < close < 100.0, f"India VIX close {close} outside any plausible historical range"

    def test_real_fetch_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own save_spot() with execute()/executemany()
        monkeypatched to a capture object instead of the real DB, then assert the captured
        INSERT params are ML-usable (real ticker shape, real finite numbers)."""
        data = nvf.fetch_spot(REAL_NT_PARAM)
        assert_non_empty_response(data, f"fetch_spot({REAL_NT_PARAM})")

        cap = _CaptureDB()
        orig_execute, orig_executemany = nvf.execute, nvf.executemany
        nvf.execute, nvf.executemany = cap.execute, cap.executemany
        try:
            nvf.save_spot(data, REAL_INDEX_NAME)
        finally:
            nvf.execute, nvf.executemany = orig_execute, orig_executemany

        assert cap.calls, "save_spot() made no execute/executemany calls at all"

        macro_calls = [(sql, params) for sql, params in cap.calls if "macro_asset_prices" in sql]
        assert macro_calls, "save_spot() never wrote to macro_asset_prices"
        sql, params = macro_calls[0]
        # params order matches the fetcher's own INSERT: (symbol, date, close, ...)
        row = {"symbol": params[0], "close": params[2]}
        assert_stored_row_ml_usable(row, numeric_cols=["close"], ticker_cols=["symbol"],
                                     context="macro_asset_prices")

        tick_calls = [(sql, params) for sql, params in cap.calls if "nt_index_pcr_ts" in sql]
        if tick_calls:
            _, tick_params = tick_calls[0]
            # (index_name, ts, expiry, pcr, volume_pcr, change_oi_pcr, index_close) -- pcr here
            # holds the intraday spot value (see the fetcher's own module docstring).
            assert isinstance(tick_params[3], (int, float)), \
                f"nt_index_pcr_ts.pcr not numeric: {tick_params[3]!r}"
