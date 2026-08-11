"""
live_datasource test for marketsmojo_fintrend_fetcher.py (see .claude/rules/data-sources.md
"Adding a New Data Source"). HDFCBANK / stockid 592009 resolved through the shared
load_sid_map() (scripts/stocklist.json).
"""

import sqlite3
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from marketsmojo_technical_fetcher import HEADERS, load_sid_map  # noqa: E402
from marketsmojo_fintrend_fetcher import (  # noqa: E402
    fetch_fintrend_history,
    write_fintrend_history,
)
from live_datasource_helpers import (  # noqa: E402
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_stored_row_ml_usable,
)

REAL_SYMBOL = "HDFCBANK"


def _make_test_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE marketsmojo_fintrend_history (
            symbol TEXT, date TEXT, score REAL, fin_trend_dir INTEGER,
            fin_txt TEXT, fetched_at TEXT,
            PRIMARY KEY (symbol, date)
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestMarketsmojoFintrendLiveDataSource:
    def test_real_stock_returns_multi_year_quarterly_history(self):
        """Step 1-3: hit the real endpoint via the fetcher's own resolution + fetch
        functions, assert it returns a real multi-point dated history, not one snapshot."""
        sid_map = load_sid_map()
        sid = sid_map.get(REAL_SYMBOL)
        assert sid, f"{REAL_SYMBOL} not found in scripts/stocklist.json's stockid map — stale?"

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        rows = fetch_fintrend_history(sid, session)
        assert_non_empty_response(rows, f"fetch_fintrend_history(sid={sid})")
        assert len(rows) >= 5, f"expected a multi-quarter history, got {len(rows)} points"
        for row in rows[:3]:
            assert row.get("date"), f"row missing a real date: {row!r}"

    def test_real_stock_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own DB-write function into a throwaway
        DB, then read the stored rows back and validate they're ML-usable."""
        sid_map = load_sid_map()
        sid = sid_map[REAL_SYMBOL]

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        rows = fetch_fintrend_history(sid, session)
        assert_non_empty_response(rows, f"fetch_fintrend_history(sid={sid})")

        conn = _make_test_db()
        n = write_fintrend_history(conn, REAL_SYMBOL, rows, "2026-08-11")
        assert n > 0, "write_fintrend_history reported 0 rows written"

        row = conn.execute(
            "SELECT * FROM marketsmojo_fintrend_history WHERE symbol=? ORDER BY date DESC LIMIT 1",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "no row landed in the throwaway DB after write"
        row = dict(row)

        assert_looks_like_ticker(row["symbol"], "stored row symbol")
        assert_stored_row_ml_usable(
            row, numeric_cols=["score"], ticker_cols=["symbol"],
            context="marketsmojo_fintrend_history",
        )
        assert row["date"], "stored row has no date"
