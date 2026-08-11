"""
live_datasource test for marketsmojo_technical_fetcher.py (see .claude/rules/data-sources.md
"Adding a New Data Source"). HDFCBANK / stockid 592009 is resolved through the fetcher's own
load_sid_map() (scripts/stocklist.json), not hardcoded, so a future stocklist.json regression
that drops the mapping fails this test instead of silently resolving nothing.
"""

import sqlite3
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from marketsmojo_technical_fetcher import (  # noqa: E402
    HEADERS,
    fetch_technical_history,
    load_sid_map,
    write_technical_history,
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
        CREATE TABLE marketsmojo_technical_history (
            symbol TEXT, indicator TEXT, period TEXT, date TEXT,
            price REAL, grade TEXT, flag INTEGER, details TEXT, fetched_at TEXT,
            PRIMARY KEY (symbol, indicator, period, date)
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestMarketsmojoTechnicalLiveDataSource:
    def test_real_stock_returns_dated_series_not_a_snapshot(self):
        """Step 1-3: hit the real endpoint via the fetcher's own resolution + fetch
        functions, assert the response is non-empty and shaped as a real dated series
        (this is the exact distinction the original assessment got wrong on the first
        pass — verifying it stays a series, not a single current value, matters)."""
        sid_map = load_sid_map()
        sid = sid_map.get(REAL_SYMBOL)
        assert sid, f"{REAL_SYMBOL} not found in scripts/stocklist.json's stockid map — stale?"

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        series = fetch_technical_history(sid, session)
        assert_non_empty_response(series, f"fetch_technical_history(sid={sid})")

        # at least the macd/rsi weekly series should be present with real depth
        macd_w = series.get(("macd", "w"))
        assert macd_w, "expected ('macd','w') series in the response — cardlist/parsing shape changed?"
        assert len(macd_w) > 100, f"expected a multi-year dated series, got {len(macd_w)} rows"
        for row in macd_w[:5]:
            assert "date" in row and row["date"], f"row missing a real date: {row!r}"

    def test_real_stock_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own DB-write function into a throwaway
        DB, then read the stored rows back and validate they're ML-usable."""
        sid_map = load_sid_map()
        sid = sid_map[REAL_SYMBOL]

        import requests
        session = requests.Session()
        session.headers.update(HEADERS)
        series = fetch_technical_history(sid, session)
        assert_non_empty_response(series, f"fetch_technical_history(sid={sid})")

        conn = _make_test_db()
        n = write_technical_history(conn, REAL_SYMBOL, series, "2026-08-11")
        assert n > 0, "write_technical_history reported 0 rows written"

        row = conn.execute(
            "SELECT * FROM marketsmojo_technical_history "
            "WHERE symbol=? AND indicator='macd' AND period='w' ORDER BY date DESC LIMIT 1",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "no macd/w row landed in the throwaway DB after write"
        row = dict(row)

        assert_looks_like_ticker(row["symbol"], "stored row symbol")
        assert_stored_row_ml_usable(
            row, numeric_cols=["price", "flag"], ticker_cols=["symbol"], context="marketsmojo_technical_history"
        )
        assert row["date"], "stored row has no date"
        assert row["details"], "stored row has no details JSON"

        import json
        details = json.loads(row["details"])
        assert isinstance(details, dict) and details, "details did not round-trip as a non-empty JSON object"
