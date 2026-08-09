"""Live-datasource test for sync_mc_index_map.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). executemany()/query_all() are bare module-level functions
imported from db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as
the nt_* fetchers.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import sync_mc_index_map as smi
from live_datasource_helpers import assert_non_empty_response


class _CaptureDB:
    def __init__(self):
        self.executemany_calls = []

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)

    def query_all(self, sql, params=None):
        if "COUNT(*)" in sql:
            return [{"c": 0}]  # sync()'s own end-of-run summary query
        return []  # no existing mappings in this throwaway context


@pytest.mark.live_datasource
class TestSyncMcIndexMapLiveDataSource:
    def test_real_fetch_produces_ml_usable_index_ids(self):
        """Hits the real MC get-indices-list endpoint via the fetcher's own
        fetch_mc_indices()."""
        indices = smi.fetch_mc_indices()
        assert_non_empty_response(indices, "fetch_mc_indices()")
        sample = indices[0]
        for key in ("index_name", "mc_name", "index_id", "exchange"):
            assert key in sample, f"index record missing {key!r}: {sample}"
        assert sample["index_name"], "index_name is empty"
        # Nifty 50 is a guaranteed-present, well-known index -- catches a parse landing on
        # the wrong JSON field entirely.
        names = {i["index_name"] for i in indices}
        assert "NIFTY50" in names, f"NIFTY50 missing from parsed index list (sample: {sorted(names)[:10]})"

    def test_sync_writes_ml_usable_rows(self):
        """Runs the fetcher's real sync() end-to-end, with executemany()/query_all()
        monkeypatched to a capture object instead of the real DB."""
        cap = _CaptureDB()
        orig_executemany, orig_query_all = smi.executemany, smi.query_all
        smi.executemany, smi.query_all = cap.executemany, cap.query_all
        try:
            smi.sync(dry_run=False)
        finally:
            smi.executemany, smi.query_all = orig_executemany, orig_query_all

        assert cap.executemany_calls, "sync() made no executemany() calls despite a real, always-populated index list"
        mc_ohlc_rows = [r for sql, r in cap.executemany_calls if r[1] == "mc_ohlc"]
        mc_pe_rows = [r for sql, r in cap.executemany_calls if r[1] == "mc_pe"]
        assert mc_ohlc_rows, "sync() wrote no mc_ohlc rows"
        assert mc_pe_rows, "sync() wrote no mc_pe rows"
        for index_name, provider, provider_id in mc_ohlc_rows[:5]:
            assert index_name, "index_provider_map.index_name is empty"
            assert provider_id, "index_provider_map.provider_id is empty"
