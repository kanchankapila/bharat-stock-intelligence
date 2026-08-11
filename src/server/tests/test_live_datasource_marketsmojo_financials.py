"""
live_datasource test for marketsmojo_financials_fetcher.py (see .claude/rules/data-sources.md
"Adding a New Data Source"). HDFCBANK / stockid 592009 resolved through the shared
load_sid_map() (scripts/stocklist.json) already exercised by the technical-history test.
"""

import sqlite3
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from marketsmojo_technical_fetcher import HEADERS, load_sid_map  # noqa: E402
from marketsmojo_financials_fetcher import (  # noqa: E402
    fetch_financials_history,
    write_financials_history,
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
        CREATE TABLE marketsmojo_financials_history (
            symbol TEXT, statement TEXT, period_label TEXT, line_item TEXT,
            value REAL, fetched_at TEXT,
            PRIMARY KEY (symbol, statement, period_label, line_item)
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestMarketsmojoFinancialsLiveDataSource:
    def test_real_stock_returns_multi_quarter_history_not_one_quarter(self):
        """Step 1-3: hit the real paginated endpoint via the fetcher's own resolution +
        fetch functions, assert it returns a real multi-year quarterly panel -- this is
        the exact distinction that made qtype=qoq the right choice over qtype=yoy (yoy
        only returns one same-quarter-last-year pair per page)."""
        sid_map = load_sid_map()
        sid = sid_map.get(REAL_SYMBOL)
        assert sid, f"{REAL_SYMBOL} not found in scripts/stocklist.json's stockid map — stale?"

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        rows = fetch_financials_history(sid, session)
        assert_non_empty_response(rows, f"fetch_financials_history(sid={sid})")

        distinct_periods = {period_label for _, period_label, _, _ in rows}
        assert len(distinct_periods) >= 10, (
            f"expected a multi-year quarterly panel, got {len(distinct_periods)} distinct "
            f"periods — pagination/qtype shape may have changed"
        )
        statements = {statement for statement, _, _, _ in rows}
        assert "consolidate" in statements or "standalone" in statements

    def test_real_stock_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own DB-write function into a throwaway
        DB, then read a real numeric line item back and validate it's ML-usable."""
        sid_map = load_sid_map()
        sid = sid_map[REAL_SYMBOL]

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        rows = fetch_financials_history(sid, session)
        assert_non_empty_response(rows, f"fetch_financials_history(sid={sid})")

        conn = _make_test_db()
        n = write_financials_history(conn, REAL_SYMBOL, rows, "2026-08-11")
        assert n > 0, "write_financials_history reported 0 rows written"

        # pick a period/line_item pair known to carry a real numeric value (not a NULL cell)
        row = conn.execute(
            "SELECT * FROM marketsmojo_financials_history "
            "WHERE symbol=? AND value IS NOT NULL ORDER BY period_label DESC LIMIT 1",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "no non-NULL value landed in the throwaway DB after write"
        row = dict(row)

        assert_looks_like_ticker(row["symbol"], "stored row symbol")
        assert_stored_row_ml_usable(
            row, numeric_cols=["value"], ticker_cols=["symbol"],
            context="marketsmojo_financials_history",
        )
        assert row["period_label"], "stored row has no period_label"
        assert row["line_item"], "stored row has no line_item"
