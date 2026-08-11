"""
live_datasource test for marketsmojo_index_fetcher.py (see .claude/rules/data-sources.md
"Adding a New Data Source"). SENSEX / index_id 1 is a hardcoded MarketsMojo id (not resolved
from stocklist.json -- this table isn't stock-scoped), chosen as the least likely index id to
ever disappear.
"""

import sqlite3
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from marketsmojo_technical_fetcher import HEADERS  # noqa: E402
from marketsmojo_index_fetcher import (  # noqa: E402
    INDEX_NAMES,
    fetch_index_history,
    write_index_history,
)
from live_datasource_helpers import (  # noqa: E402
    assert_non_empty_response,
    assert_numeric_and_finite,
)

REAL_INDEX_ID = 1  # SENSEX


def _make_test_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE marketsmojo_index_history (
            index_id INTEGER, name TEXT, date TEXT, price REAL, fetched_at TEXT,
            PRIMARY KEY (index_id, date)
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestMarketsmojoIndexLiveDataSource:
    def test_real_index_returns_multi_year_daily_history(self):
        """Step 1-3: hit the real endpoint via the fetcher's own fetch function, assert it
        returns a real multi-year daily series -- this is the exact distinction that
        matters here: period=1D/1w are intraday minute-ticks, period=3Y is daily."""
        assert REAL_INDEX_ID in INDEX_NAMES, "SENSEX (id=1) missing from INDEX_NAMES — stale?"

        session = __import__("requests").Session()
        session.headers.update(HEADERS)
        rows = fetch_index_history(REAL_INDEX_ID, session)
        assert_non_empty_response(rows, f"fetch_index_history(id={REAL_INDEX_ID})")
        assert len(rows) > 500, f"expected ~3 years of daily rows, got {len(rows)}"

        for row in rows[:5]:
            assert row.get("date"), f"row missing a real date: {row!r}"
            assert_numeric_and_finite(row.get("price"), "index price")

    def test_real_index_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own DB-write function into a throwaway
        DB, then read the stored rows back and validate they're ML-usable."""
        session = __import__("requests").Session()
        session.headers.update(HEADERS)
        rows = fetch_index_history(REAL_INDEX_ID, session)
        assert_non_empty_response(rows, f"fetch_index_history(id={REAL_INDEX_ID})")

        conn = _make_test_db()
        n = write_index_history(conn, REAL_INDEX_ID, INDEX_NAMES[REAL_INDEX_ID], rows, "2026-08-11")
        assert n > 0, "write_index_history reported 0 rows written"

        row = conn.execute(
            "SELECT * FROM marketsmojo_index_history WHERE index_id=? ORDER BY date DESC LIMIT 1",
            (REAL_INDEX_ID,),
        ).fetchone()
        assert row is not None, "no row landed in the throwaway DB after write"
        row = dict(row)

        assert row["name"] == "SENSEX"
        assert_numeric_and_finite(row["price"], "stored index price")
        assert row["date"], "stored row has no date"
