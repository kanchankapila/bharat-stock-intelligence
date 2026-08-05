"""Live-datasource test for backfill_sector_mc.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). A manual/idempotent backfill utility (not scheduled), MoneyControl
pricefeed-sourced (main_sector/newSubsector -> GICS mapping).

write_db() reads from a JSON cache file on disk (_CACHE) rather than an in-memory
structure, so this test writes a REAL fetched result into a TEMPORARY cache file, runs the
fetcher's own write_db() against it (execute() monkeypatched to a capture object instead of
the real DB), and restores whatever was on disk at _CACHE beforehand in a finally block --
this repo's real mc_sector_cache.json (a working file from real usage) must never be
clobbered by a test run.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import backfill_sector_mc as bsm
from live_datasource_helpers import assert_looks_like_ticker

REAL_SYMBOL = "RELIANCE"
REAL_MCSYMBOL = "RI"


class _CaptureDB:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))


@pytest.mark.live_datasource
class TestBackfillSectorMcLiveDataSource:
    def test_real_fetch_returns_ml_usable_sector(self):
        """Hits the real MC pricefeed endpoint for RELIANCE via the fetcher's own
        _fetch()."""
        session = bsm._session()
        main, sub = bsm._fetch(session, REAL_MCSYMBOL)
        assert main or sub, "MC pricefeed returned no main_sector/newSubsector for RELIANCE -- endpoint may be down/changed"
        if main:
            assert main in bsm._GICS, \
                f"RELIANCE's real MC main_sector {main!r} has no GICS mapping -- _GICS table may need extending"

    def test_write_db_maps_and_writes_ml_usable_row(self):
        """Writes a real fetched RELIANCE sector through the fetcher's own write_db(),
        via a temporary cache file (the original mc_sector_cache.json is preserved and
        restored regardless of test outcome), with execute() monkeypatched to a capture
        object instead of the real DB."""
        session = bsm._session()
        main, sub = bsm._fetch(session, REAL_MCSYMBOL)
        if not main and not sub:
            pytest.skip("MC returned no classification for RELIANCE on this run")

        original_cache_bytes = bsm._CACHE.read_bytes() if bsm._CACHE.exists() else None
        cap = _CaptureDB()
        orig_execute = bsm.execute
        try:
            bsm._CACHE.write_text(json.dumps({REAL_SYMBOL: [main, sub]}))
            bsm.execute = cap.execute
            bsm.write_db(report_unmapped=False)
        finally:
            bsm.execute = orig_execute
            if original_cache_bytes is not None:
                bsm._CACHE.write_bytes(original_cache_bytes)
            elif bsm._CACHE.exists():
                bsm._CACHE.unlink()

        assert cap.calls, "write_db() made no execute() calls despite a real classified symbol"
        sql, params = cap.calls[0]
        gics, industry, symbol = params
        assert_looks_like_ticker(symbol, context="nse_stocks.symbol")
        assert symbol == REAL_SYMBOL
        if main:
            assert gics == bsm._GICS.get(main)
