"""Live-datasource test for sync_nt_fno_symbols.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). execute()/executemany() are imported at module level for
sync_index_map(), but sync_fno_symbols()/sync_fno_expiries() each do a FRESH
`from db_compat import execute/executemany as _exec...` inside the function body on every
call -- so monkeypatching only `snf.execute`/`snf.executemany` (bound once at import time)
would silently miss those two; this test also monkeypatches `db_compat.execute`/
`db_compat.executemany` directly, which both the module-level import and the function-local
re-imports ultimately read from.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import db_compat
import sync_nt_fno_symbols as snf
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite


class _CaptureDB:
    def __init__(self):
        self.execute_calls = []
        self.executemany_calls = []

    def execute(self, sql, params=None):
        self.execute_calls.append((sql, params))

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)

    def query_all(self, sql, params=None):
        return []


@pytest.mark.live_datasource
class TestSyncNtFnoSymbolsLiveDataSource:
    def test_real_endpoints_produce_ml_usable_data(self):
        """Hits all 3 real NiftyTrader endpoints via the fetcher's own _fetch()."""
        idx_data = snf._fetch(snf.INDEX_DATA_URL)
        assert idx_data, "stock-index-data endpoint returned nothing -- may be down/changed"
        assert any(e.get("symbol_name", "").strip() in snf._NT_INDEX_MAP for e in idx_data), \
            "none of the real index entries matched a known NT index name -- endpoint shape may have changed"

        sym_data = snf._fetch(snf.PSYMBOL_URL)
        assert sym_data, "psymbol-list endpoint returned nothing -- may be down/changed"
        sample = sym_data[0]
        assert sample.get("symbol_name"), "F&O symbol entry missing symbol_name"

        exp_data = snf._fetch(
            "https://webapi.niftytrader.in/webapi/Symbol/symbol-expiry-all?symbol=nifty&exchange=nse"
        )
        assert exp_data, "symbol-expiry-all endpoint returned nothing -- may be down/changed"
        exp_sample = exp_data[0]
        assert exp_sample.get("expiry_date"), "expiry entry missing expiry_date"

    def test_sync_writes_ml_usable_rows_via_own_functions(self):
        """Runs all 3 real sync sub-functions end-to-end, with execute()/executemany()
        monkeypatched at both the module-level-import site (snf.*) and the db_compat
        module itself (for the two function-local re-imports)."""
        cap = _CaptureDB()
        orig = {
            "snf_execute": snf.execute, "snf_executemany": snf.executemany, "snf_query_all": snf.query_all,
            "dbc_execute": db_compat.execute, "dbc_executemany": db_compat.executemany,
        }
        snf.execute, snf.executemany, snf.query_all = cap.execute, cap.executemany, cap.query_all
        db_compat.execute, db_compat.executemany = cap.execute, cap.executemany
        try:
            snf.sync(dry_run=False)
        finally:
            snf.execute, snf.executemany, snf.query_all = orig["snf_execute"], orig["snf_executemany"], orig["snf_query_all"]
            db_compat.execute, db_compat.executemany = orig["dbc_execute"], orig["dbc_executemany"]

        assert cap.executemany_calls, "sync() made no executemany() calls despite real, always-populated endpoints"

        idx_rows = [r for sql, r in cap.executemany_calls if "index_provider_map" in sql]
        assert idx_rows, "sync_index_map() wrote no index_provider_map rows"
        for index_name, provider, provider_id in idx_rows[:5]:
            assert index_name, "index_provider_map.index_name is empty"

        exp_rows = [r for sql, r in cap.executemany_calls if "nt_fno_expiry" in sql]
        assert exp_rows, "sync_fno_expiries() wrote no nt_fno_expiry rows"
        for symbol, exchange, expiry, lot_size in exp_rows[:5]:
            assert_looks_like_ticker(symbol, context="nt_fno_expiry.symbol")
            assert expiry, "nt_fno_expiry.expiry is empty"

        assert cap.execute_calls, "sync_fno_symbols()'s per-row UPDATE (via a function-local db_compat re-import) never fired"
        sql, params = cap.execute_calls[0]
        assert "nse_stocks" in sql
        lot, ts, sym = params
        assert_looks_like_ticker(sym, context="nse_stocks.symbol (fno update)")
