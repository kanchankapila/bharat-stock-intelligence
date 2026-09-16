"""Regression test for nt_oi_snapshot_fetcher.py's index_max_pain write -- pinned as part of
migration 1787010000000 (index_max_pain PK widened to (source, index_name, date, expiry) since
mc_index_oi_fetcher.py and this fetcher both write NIFTY50/NIFTYBANK from independently-derived
OI data and were silently overwriting each other, confirmed live 2026-08-15: 93 MC-derived vs
11 NT-derived rows coexisting under the same pre-fix 3-column key).

save_snapshot() doesn't hit the network (takes `data` as a plain param), so this needs no
`live_datasource` marker -- same shape as test_mc_index_oi_max_pain.py.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import nt_oi_snapshot_fetcher as noi


class _CaptureDB:
    """Fakes db_compat's bare execute()/executemany() -- nt_oi_snapshot_fetcher.py imports
    them as bare module-level functions (like the other nt_* fetchers), no `con` injection
    point to use instead."""
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def executemany(self, sql, rows):
        for row in rows:
            self.calls.append((sql, row))


REAL_DATA = [
    {"strike_price": 24000, "expiry_date": "2026-08-28", "time": "2026-08-15T15:20:00",
     "index_close": 24350.5, "calls_oi": 120000, "puts_oi": 98000,
     "calls_change_oi": 2000, "puts_change_oi": -1500, "calls_volume": 5000, "puts_volume": 4200,
     "calls_oi_value": 1.2e9, "puts_oi_value": 0.9e9},
    {"strike_price": 24500, "expiry_date": "2026-08-28", "time": "2026-08-15T15:20:00",
     "index_close": 24350.5, "calls_oi": 150000, "puts_oi": 60000,
     "calls_change_oi": 1000, "puts_change_oi": -500, "calls_volume": 6000, "puts_volume": 3000,
     "calls_oi_value": 1.5e9, "puts_oi_value": 0.6e9},
]


class TestSaveSnapshotIndexMaxPain:
    def test_writes_source_into_index_max_pain(self):
        cap = _CaptureDB()
        orig_execute, orig_executemany = noi.execute, noi.executemany
        noi.execute, noi.executemany = cap.execute, cap.executemany
        try:
            n = noi.save_snapshot("NIFTY50", REAL_DATA, "2026-08-15")
        finally:
            noi.execute, noi.executemany = orig_execute, orig_executemany

        assert n == 2
        mp_calls = [(sql, params) for sql, params in cap.calls if "index_max_pain" in sql]
        assert mp_calls, "save_snapshot() never wrote to index_max_pain"
        _, params = mp_calls[0]
        # INSERT param order: (source, index_name, date, expiry, max_pain, pcr_oi, total_ce_oi, total_pe_oi, fetched_at)
        assert params[0] == noi.SOURCE == "niftytrader"
        assert params[1] == "NIFTY50"
        assert params[2] == "2026-08-15"
        assert params[3] == "2026-08-28"

    def test_oi_eod_rows_unaffected_by_the_source_column(self):
        """index_max_pain's key widened; nt_index_oi_eod (the sibling table this same function
        writes) did not change shape and must keep its original param order."""
        cap = _CaptureDB()
        orig_execute, orig_executemany = noi.execute, noi.executemany
        noi.execute, noi.executemany = cap.execute, cap.executemany
        try:
            noi.save_snapshot("NIFTY50", REAL_DATA, "2026-08-15")
        finally:
            noi.execute, noi.executemany = orig_execute, orig_executemany

        oi_calls = [(sql, params) for sql, params in cap.calls if "nt_index_oi_eod" in sql]
        assert oi_calls
        _, params = oi_calls[0]
        # INSERT param order: (index_name, date, expiry, strike, snap_time, ...)
        assert params[0] == "NIFTY50"
        assert params[1] == "2026-08-15"
