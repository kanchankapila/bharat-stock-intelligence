"""Live-datasource test for nifty_pe_fetcher.py (see CLAUDE.md's "Adding a new data source"
mandatory rule). execute()/executemany() are bare module-level functions imported from
db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as the nt_* fetchers.
NIFTY50 (MC indId=9, Trendlyne tlid=1887) -- the single most liquid, always-populated index.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nifty_pe_fetcher as npe
from live_datasource_helpers import assert_numeric_and_finite

REAL_IND_ID = 9
REAL_TLID = 1887
REAL_INDEX_NAME = "NIFTY50"


class _CaptureDB:
    def __init__(self):
        self.executemany_calls = []

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)


@pytest.mark.live_datasource
class TestNiftyPeFetcherLiveDataSource:
    def test_mc_and_trendlyne_endpoints_produce_ml_usable_data(self):
        """Hits both real sources for NIFTY50 via the fetcher's own fetch_mc_pe_pb()/
        fetch_trendlyne()."""
        mc_data = npe.fetch_mc_pe_pb(REAL_IND_ID, days=30)
        assert mc_data, "fetch_mc_pe_pb() returned zero dates for NIFTY50 -- MC endpoint may be down/changed"
        for date_str, vals in list(mc_data.items())[:5]:
            assert date_str, "MC PE/PB row missing date"
            if vals.get("pe") is not None:
                assert_numeric_and_finite(vals["pe"], context="index_valuation.pe (MC)")

        tl_points = npe.fetch_trendlyne(REAL_TLID, "PE_TTM_SHARE_NOW")
        assert tl_points, "fetch_trendlyne() returned zero points for NIFTY50 PE_TTM -- endpoint may be down/changed"
        for date_str, val in tl_points[:5]:
            assert date_str
            assert_numeric_and_finite(val, context="index_valuation.pe (Trendlyne)")

    def test_run_writes_ml_usable_rows(self):
        """Runs the fetcher's real run() end-to-end for a real recent window, with
        executemany() monkeypatched to a capture object instead of the real DB."""
        cap = _CaptureDB()
        orig_executemany = npe.executemany
        orig_execute = npe.execute
        npe.executemany = cap.executemany
        npe.execute = lambda *a, **k: None  # _ensure_table()'s CREATE TABLE -- no-op, no real DB touched
        # Scope the index universe down to just NIFTY50 so this doesn't hammer every index.
        orig_build_map = npe._build_index_map
        npe._build_index_map = lambda: {REAL_IND_ID: (REAL_INDEX_NAME, REAL_TLID)}
        try:
            npe.run(days=30, full=False)
        finally:
            npe.executemany, npe.execute = orig_executemany, orig_execute
            npe._build_index_map = orig_build_map

        assert cap.executemany_calls, "run() made no executemany() calls despite a real, always-populated index"
        for sql, row in cap.executemany_calls[:10]:
            index_name, date, pe, pb, div_yield, eps, fetched_at = row
            assert index_name == REAL_INDEX_NAME
            assert date, "index_valuation.date is empty"
            if pe is not None:
                assert_numeric_and_finite(pe, context="index_valuation.pe")
