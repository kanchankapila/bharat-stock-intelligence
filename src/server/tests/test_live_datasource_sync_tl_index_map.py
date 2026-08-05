"""Live-datasource test for sync_tl_index_map.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). executemany()/query_all() are bare module-level functions
imported from db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as
the nt_* fetchers.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import sync_tl_index_map as sti


class _CaptureDB:
    def __init__(self):
        self.executemany_calls = []

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)

    def query_all(self, sql, params=None):
        if "COUNT(*)" in sql:
            return [{"c": 0}]  # sync()'s own end-of-run summary queries
        return []  # no existing mappings in this throwaway context


@pytest.mark.live_datasource
class TestSyncTlIndexMapLiveDataSource:
    def test_real_fetch_produces_ml_usable_index_ids(self):
        """Hits both real Trendlyne endpoints (sector/index analysis + global indices) via
        the fetcher's own fetch_all()."""
        rows = sti.fetch_all()
        assert set(rows.keys()) == {"trendlyne", "trendlyne_sector", "trendlyne_industry"}
        assert rows["trendlyne"], "fetch_all() produced zero 'trendlyne' index rows -- endpoint may be down/changed"

        names = {r[0] for r in rows["trendlyne"]}
        assert "NIFTY50" in names, f"NIFTY50 missing from parsed Trendlyne index list (sample: {sorted(names)[:10]})"
        for idx_name, provider, tlid in rows["trendlyne"][:10]:
            assert idx_name, "trendlyne index_name is empty"
            assert provider == "trendlyne"
            assert tlid, "trendlyne provider_id (tlid) is empty"

        assert rows["trendlyne_sector"], "fetch_all() produced zero sector rows -- endpoint may be down/changed"
        assert rows["trendlyne_industry"], "fetch_all() produced zero industry rows -- endpoint may be down/changed"

    def test_sync_writes_ml_usable_rows(self):
        """Runs the fetcher's real sync() end-to-end, with executemany()/query_all()
        monkeypatched to a capture object instead of the real DB."""
        cap = _CaptureDB()
        orig_executemany, orig_query_all = sti.executemany, sti.query_all
        sti.executemany, sti.query_all = cap.executemany, cap.query_all
        try:
            sti.sync(dry_run=False)
        finally:
            sti.executemany, sti.query_all = orig_executemany, orig_query_all

        assert cap.executemany_calls, "sync() made no executemany() calls despite a real, always-populated index list"
        tl_rows = [r for sql, r in cap.executemany_calls if r[1] == "trendlyne"]
        assert tl_rows, "sync() wrote no 'trendlyne' provider rows"
        for index_name, provider, provider_id in tl_rows[:5]:
            assert index_name, "index_provider_map.index_name is empty"
            assert provider_id, "index_provider_map.provider_id is empty"
