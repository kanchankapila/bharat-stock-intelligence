"""Live-datasource test for mc_ohlcv_backfill.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). Manual/one-time deep-history backfill (not scheduled), but still
a real external fetcher per the mandate. RELIANCE chosen -- guaranteed decades of history.
"""
import os


import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import mc_ohlcv_backfill as mob
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


def _make_test_conn():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE stock_ohlcv (
        symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        adjustment_basis TEXT,
        PRIMARY KEY (symbol, date)
    )""")
    conn.commit()
    return conn


@pytest.mark.live_datasource
class TestMcOhlcvBackfillLiveDataSource:
    def test_real_fetch_produces_ml_usable_bars(self):
        """Hits the real MC techCharts deep-history endpoint for RELIANCE via the fetcher's
        own fetch_one()."""
        session = requests.Session()
        session.headers.update(mob.HEADERS)
        sym, status, rows = mob.fetch_one(REAL_SYMBOL, session, from_year=2020)
        assert status == "ok", f"fetch_one() returned status {status!r} for RELIANCE -- endpoint may be down/changed"
        assert rows, "fetch_one() returned zero bars for RELIANCE since 2020"
        sample = rows[0]
        symbol, date, o, h, l, c, v, basis = sample
        assert symbol == REAL_SYMBOL
        assert_numeric_and_finite(c, context="close")
        assert basis == "split_only"

    def test_upsert_writes_ml_usable_rows(self):
        """Writes real fetched RELIANCE bars through the fetcher's own upsert() into a
        throwaway DB."""
        session = requests.Session()
        session.headers.update(mob.HEADERS)
        sym, status, rows = mob.fetch_one(REAL_SYMBOL, session, from_year=2020)
        assert rows, "no real bars to exercise the write path with"

        conn = _make_test_conn()
        mob.ensure_adjustment_basis_column(conn)
        n = mob.upsert(conn, rows, overwrite=False)
        assert n > 0, "upsert() reported zero rows written despite real fetched bars"

        row = conn.execute(
            "SELECT symbol, close, adjustment_basis FROM stock_ohlcv WHERE symbol = ? LIMIT 1",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "upsert() reported success but wrote no row"
        assert_looks_like_ticker(row["symbol"], context="stock_ohlcv.symbol")
        assert_numeric_and_finite(row["close"], context="stock_ohlcv.close")
        assert row["adjustment_basis"] == "split_only"
        conn.close()
