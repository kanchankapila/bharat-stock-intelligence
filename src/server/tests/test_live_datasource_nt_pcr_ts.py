"""Live-datasource test for nt_pcr_ts_fetcher.py (see CLAUDE.md's "Adding a new data source"
mandatory rule). Second of the 4 nt_* NiftyTrader fetchers flagged in the 2026-08-04 "Audit
backlog + live_datasource coverage" session as needing the monkeypatch-on-module-level-DB-
functions pattern (executemany() is a bare module-level import, no `con` parameter to inject
a test DB through -- same shape as nt_vix_fetcher.py, covered separately).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nt_pcr_ts_fetcher as npf
from live_datasource_helpers import assert_non_empty_response

# NIFTY50/nse_pcr_data needs no DB lookup (it's _FALLBACK's first entry) and no auth --
# confirmed by reading the fetcher before writing this.
REAL_NT_SYMBOL = "nifty"
REAL_REQ_TYPE = "nse_pcr_data"
REAL_INDEX_NAME = "NIFTY50"


class _CaptureExecuteMany:
    """Fakes db_compat's bare executemany() by recording rows instead of touching a real DB."""
    def __init__(self):
        self.rows = []

    def executemany(self, sql, rows):
        self.rows.extend(rows)


@pytest.mark.live_datasource
class TestNtPcrTsLiveDataSource:
    def test_real_fetch_returns_ml_usable_pcr_series(self):
        """Step 1-3: hit the real NiftyTrader PCR endpoint for NIFTY, parse with the fetcher's
        own fetch_pcr(), assert at least one real numeric PCR tick came back."""
        expiries, data = npf.fetch_pcr(REAL_NT_SYMBOL, REAL_REQ_TYPE)
        assert_non_empty_response(data, f"fetch_pcr({REAL_NT_SYMBOL})")
        assert expiries, "fetch_pcr returned no expiry dates alongside the tick data"

        pcr_vals = [npf._sf(rec.get("pcr")) for rec in data]
        real_vals = [v for v in pcr_vals if v is not None]
        assert real_vals, "every tick's pcr field failed to parse as a number"
        # PCR is a ratio of puts to calls OI -- always non-negative, and values above ~10 would
        # indicate a parse landing on the wrong field (e.g. raw OI instead of the ratio).
        assert all(0 <= v < 10 for v in real_vals), \
            f"pcr values outside plausible [0,10) range: {[v for v in real_vals if not (0 <= v < 10)]}"

    def test_real_fetch_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own save_pcr_ts() with executemany()
        monkeypatched to a capture object, then assert the captured rows are ML-usable."""
        _, data = npf.fetch_pcr(REAL_NT_SYMBOL, REAL_REQ_TYPE)
        assert_non_empty_response(data, f"fetch_pcr({REAL_NT_SYMBOL})")

        cap = _CaptureExecuteMany()
        orig_executemany = npf.executemany
        npf.executemany = cap.executemany
        try:
            n = npf.save_pcr_ts(REAL_INDEX_NAME, data)
        finally:
            npf.executemany = orig_executemany

        assert n > 0, "save_pcr_ts() saved 0 rows from a non-empty fetch"
        assert cap.rows, "save_pcr_ts() made no executemany call despite returning n>0"

        # (index_name, ts, expiry, pcr, volume_pcr, change_oi_pcr, index_close)
        index_name, ts, expiry, pcr, _, _, index_close = cap.rows[0]
        assert index_name == REAL_INDEX_NAME
        assert ts and expiry, f"ts/expiry not populated: ts={ts!r} expiry={expiry!r}"
        assert isinstance(pcr, (int, float)), f"pcr not numeric: {pcr!r}"
        if index_close is not None:
            assert isinstance(index_close, (int, float)) and index_close > 0, \
                f"index_close not a usable positive number: {index_close!r}"
