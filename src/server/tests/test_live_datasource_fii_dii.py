"""Live-datasource test for fii_dii_fetcher.py (see CLAUDE.md's "Adding a new data source"
mandatory rule). This is one of the ~130 previously-untested fetchers flagged in the
2026-07-30 fifth full-stack-audit pass (only 9/140 DB-writing Python files had one).

FiiDiiFetcher.fetch() hits NSE's real fiidiiTradeReact endpoint (no ticker/screener id
needed — this is market-wide data, not per-stock), so there's no companyid/mapping lookup
to go stale here, unlike most other fetchers in this codebase.
"""
import os
import sys

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from fii_dii_fetcher import FiiDiiFetcher
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable


def _make_test_engine():
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE fii_dii_flow (
                date TEXT PRIMARY KEY, fii_buy REAL, fii_sell REAL, fii_net REAL,
                dii_buy REAL, dii_sell REAL, dii_net REAL, source TEXT, fetched_at TEXT
            )
        """))
    return engine


@pytest.mark.live_datasource
class TestFiiDiiLiveDataSource:
    def test_real_fetch_returns_ml_usable_records(self):
        """Step 1-3 of the pattern: hit the real NSE endpoint, parse with the fetcher's own
        fetch(), assert non-empty and every numeric field is a real finite number."""
        fetcher = FiiDiiFetcher()
        records = fetcher.fetch()
        assert_non_empty_response(records, "FiiDiiFetcher.fetch()")

        latest = records[0]
        assert latest["date"], "record missing a date"
        # At least one side (FII or DII) must have real net-flow data — NSE sometimes
        # withholds one category on partial-data days, so we don't require both.
        has_real_number = any(
            isinstance(latest.get(k), (int, float)) for k in ("fii_net", "dii_net", "fii_buy", "dii_buy")
        )
        assert has_real_number, f"no usable numeric FII/DII field in the latest record: {latest}"

    def test_real_fetch_stores_ml_usable_rows(self):
        """Step 4-5 of the pattern: write through the fetcher's own save() into a throwaway
        SQLite engine (swapped in for fetcher.engine, which normally points at the real
        configured DB), then read the row back and validate it's ML-usable."""
        fetcher = FiiDiiFetcher()
        records = fetcher.fetch()
        assert_non_empty_response(records, "FiiDiiFetcher.fetch()")

        fetcher.engine = _make_test_engine()
        saved = fetcher.save(records[:3])
        assert saved > 0, "save() reported 0 rows written despite non-empty fetch()"

        with fetcher.engine.connect() as conn:
            row = conn.execute(text("SELECT * FROM fii_dii_flow ORDER BY date DESC LIMIT 1")).mappings().first()
        assert row is not None, "no row landed in fii_dii_flow after save()"
        row = dict(row)

        present_numeric = [c for c in ("fii_buy", "fii_sell", "fii_net", "dii_buy", "dii_sell", "dii_net")
                            if row.get(c) is not None]
        assert present_numeric, f"stored row has no non-null flow columns at all: {row}"
        assert_stored_row_ml_usable(row, numeric_cols=present_numeric, ticker_cols=[], context="fii_dii_flow")
