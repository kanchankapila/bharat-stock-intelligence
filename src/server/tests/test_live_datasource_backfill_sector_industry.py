"""Live-datasource test for backfill_sector_industry.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). A manual/idempotent backfill utility (not scheduled), Yahoo
Finance quoteSummary-sourced.

Lighter-scope (see et_stats' documented precedent): the DB write is inlined directly in
main()'s argparse-driven loop rather than a standalone function, so this validates
fetch+parse (via the fetcher's own _make_session()/_fetch_profile()) plus a write-through
using main()'s own UPDATE statement text against a throwaway sqlite DB, rather than
invoking the whole CLI entry point.
"""
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import backfill_sector_industry as bsi
from live_datasource_helpers import assert_looks_like_ticker

REAL_SYMBOL = "RELIANCE"


@pytest.mark.live_datasource
class TestBackfillSectorIndustryLiveDataSource:
    def test_real_crumb_handshake_and_fetch(self):
        """Performs the real Yahoo crumb handshake via the fetcher's own _make_session(),
        then fetches RELIANCE's real sector/industry via its own _fetch_profile()."""
        session = bsi._make_session()
        assert getattr(session, "_crumb", None), "_make_session() didn't obtain a real crumb"

        sector, industry = bsi._fetch_profile(session, REAL_SYMBOL)
        assert sector or industry, "Yahoo quoteSummary returned no sector/industry for RELIANCE -- endpoint may be down/changed"
        if sector:
            assert isinstance(sector, str) and sector, "sector is not a real non-empty string"
        if industry:
            assert isinstance(industry, str) and industry, "industry is not a real non-empty string"

    def test_write_uses_real_data_and_stores_ml_usable_row(self):
        """Writes the real fetched RELIANCE sector/industry through main()'s own UPDATE
        statement text into a throwaway sqlite DB (the write is inlined in main()'s
        argparse-driven loop, not a standalone function -- see module docstring)."""
        session = bsi._make_session()
        sector, industry = bsi._fetch_profile(session, REAL_SYMBOL)
        if not sector and not industry:
            pytest.skip("Yahoo returned no classification for RELIANCE on this run")

        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, sector TEXT, industry TEXT, last_updated TEXT)")
        conn.execute("INSERT INTO nse_stocks (symbol, sector, industry) VALUES (?, 'Unknown', NULL)", (REAL_SYMBOL,))
        conn.execute(
            "UPDATE nse_stocks SET sector = COALESCE(?, sector), "
            "industry = COALESCE(?, industry), last_updated = CURRENT_TIMESTAMP "
            "WHERE symbol = ?",
            (sector, industry, REAL_SYMBOL),
        )
        conn.commit()

        row = conn.execute("SELECT symbol, sector, industry FROM nse_stocks WHERE symbol = ?", (REAL_SYMBOL,)).fetchone()
        assert row is not None
        assert_looks_like_ticker(row[0], context="nse_stocks.symbol")
        if sector:
            assert row[1] == sector
        conn.close()
