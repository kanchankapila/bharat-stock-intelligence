"""Live-datasource test for mc_global_macro_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). run(dry_run=True) does the real fetch+parse across all 5 real MC
endpoints without touching a DB -- used for the fetch/parse half of the mandate; the
write half is exercised separately with a throwaway sqlite connection via the fetcher's own
ensure_schema()/write_all().
"""
import os


import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import mc_global_macro_fetcher as gmm
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite


@pytest.mark.live_datasource
class TestMcGlobalMacroFetcherLiveDataSource:
    def test_dry_run_fetches_and_parses_real_endpoints(self):
        """Hits all 5 real MC endpoints (indices overview+technical, commodities,
        currencies, Indian ADRs) via the fetcher's own run(dry_run=True), which does the
        real fetch and real parse but skips the DB write."""
        result = gmm.run(dry_run=True)
        assert result["dry_run"] is True
        assert result["records"] > 0, "run(dry_run=True) parsed zero records across all 5 real endpoints -- may be down/blocked"

    def test_write_all_stores_ml_usable_rows(self):
        """Re-fetches real data via the individual endpoint calls (mirroring run()'s own
        steps) and writes it through the fetcher's own ensure_schema()/write_all() into a
        throwaway sqlite connection."""
        ov = gmm._get(gmm.ENDPOINTS["idx_overview"])
        tch = gmm._get(gmm.ENDPOINTS["idx_technical"])
        assert ov and tch, "global indices overview/technical endpoints returned nothing -- may be down"

        records = gmm.parse_indices(ov, tch)
        assert records, "parse_indices() produced zero records from a real non-empty response"

        conn = pg_memory_conn()
        conn.execute("""CREATE TABLE macro_asset_prices (
            date TEXT, symbol TEXT, close REAL, ret_1d REAL, ret_5d REAL, fetched_at TEXT,
            PRIMARY KEY (date, symbol)
        )""")
        gmm.ensure_schema(conn)

        today = "2026-01-01"
        gmm.write_all(conn, records, today)

        snap_rows = conn.execute(
            "SELECT symbol, price, ret_1d FROM mc_global_snapshot WHERE date = ?", (today,)
        ).fetchall()
        assert snap_rows, "write_all() wrote zero rows to mc_global_snapshot despite real parsed records"
        for symbol, price, ret_1d in snap_rows:
            assert symbol, "mc_global_snapshot.symbol is empty"
            if price is not None:
                assert_numeric_and_finite(price, context=f"mc_global_snapshot.{symbol}.price")

        macro_rows = conn.execute(
            "SELECT symbol, close FROM macro_asset_prices WHERE date = ?", (today,)
        ).fetchall()
        assert macro_rows, "write_all() wrote zero rows to macro_asset_prices despite records with a price"
        for symbol, close in macro_rows:
            assert_numeric_and_finite(close, context=f"macro_asset_prices.{symbol}.close")
        conn.close()
