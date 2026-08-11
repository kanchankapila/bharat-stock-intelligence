"""
live_datasource test for marketsmojo_shareholding_fetcher.py (see .claude/rules/data-sources.md
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
from marketsmojo_shareholding_fetcher import (  # noqa: E402
    fetch_shareholding_history,
    write_shareholding_history,
)
from live_datasource_helpers import (  # noqa: E402
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_numeric_and_finite,
)

REAL_SYMBOL = "HDFCBANK"


def _make_test_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE marketsmojo_shareholding_history (
            symbol TEXT, category TEXT, period_date TEXT, value REAL, fetched_at TEXT,
            PRIMARY KEY (symbol, category, period_date)
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestMarketsmojoShareholdingLiveDataSource:
    def test_real_stock_returns_multi_quarter_ownership_history(self):
        """Step 1-3: hit the real endpoint via the fetcher's own resolution + fetch
        functions, assert it returns real multi-quarter ownership-% history across
        more than one holder category (promoter/FII/MF/...), not a single snapshot."""
        sid_map = load_sid_map()
        sid = sid_map.get(REAL_SYMBOL)
        assert sid, f"{REAL_SYMBOL} not found in scripts/stocklist.json's stockid map — stale?"

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        rows = fetch_shareholding_history(sid, session)
        assert_non_empty_response(rows, f"fetch_shareholding_history(sid={sid})")

        categories = {cat for cat, _, _ in rows}
        assert len(categories) >= 3, f"expected multiple holder categories, got {categories}"
        periods = {period for _, period, _ in rows}
        assert len(periods) >= 2, f"expected multi-quarter history, got {len(periods)} period(s)"

    def test_real_stock_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own DB-write function into a throwaway
        DB, then read a real numeric value back and validate it's ML-usable."""
        sid_map = load_sid_map()
        sid = sid_map[REAL_SYMBOL]

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        rows = fetch_shareholding_history(sid, session)
        assert_non_empty_response(rows, f"fetch_shareholding_history(sid={sid})")

        conn = _make_test_db()
        n = write_shareholding_history(conn, REAL_SYMBOL, rows, "2026-08-11")
        assert n > 0, "write_shareholding_history reported 0 rows written"

        row = conn.execute(
            "SELECT * FROM marketsmojo_shareholding_history "
            "WHERE symbol=? AND category='fii_holdings_pct' ORDER BY period_date DESC LIMIT 1",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "no fii_holdings_pct row landed in the throwaway DB after write"
        row = dict(row)

        assert_looks_like_ticker(row["symbol"], "stored row symbol")
        assert_numeric_and_finite(row["value"], "stored shareholding value")
        assert row["period_date"], "stored row has no period_date"
