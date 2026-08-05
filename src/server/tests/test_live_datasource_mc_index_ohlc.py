"""Live-datasource test for mc_index_ohlc_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). execute()/executemany()/query_all() are bare module-level functions
imported from db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as the
nt_* fetchers. NIFTY50 (ind_id=9) chosen -- the single most liquid, always-populated index.
"""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mc_index_ohlc_fetcher as mio
from live_datasource_helpers import assert_numeric_and_finite

REAL_IND_ID = 9
REAL_SYMBOL = "NIFTY50"


class _CaptureDB:
    def __init__(self):
        self.executemany_calls = []

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)

    def query_all(self, sql, params=None):
        return []


@pytest.mark.live_datasource
class TestMcIndexOhlcFetcherLiveDataSource:
    def test_real_fetch_produces_ml_usable_bars(self):
        """Hits the real MC appfeeds graph endpoint for NIFTY50 via the fetcher's own
        fetch_index_ohlc()."""
        session = requests.Session()
        session.headers.update(mio.HEADERS)
        rows = mio.fetch_index_ohlc(session, REAL_IND_ID, "1m")
        assert rows, "fetch_index_ohlc() returned zero bars for NIFTY50 (1m range) -- endpoint may be down/changed"
        for r in rows[:5]:
            assert r["date"], "OHLC row missing date"
            assert_numeric_and_finite(r["close"], context="stock_ohlcv.close")
            if r["high"] is not None and r["low"] is not None:
                assert r["high"] >= r["low"], f"bar has high < low: {r}"

    def test_upsert_writes_ml_usable_rows(self):
        """Writes real fetched NIFTY50 bars through the fetcher's own upsert_ohlc(), with
        executemany()/query_all() monkeypatched to a capture object instead of the real DB."""
        session = requests.Session()
        session.headers.update(mio.HEADERS)
        rows = mio.fetch_index_ohlc(session, REAL_IND_ID, "1m")
        assert rows, "no real bars to exercise the write path with"

        cap = _CaptureDB()
        orig_executemany, orig_query_all = mio.executemany, mio.query_all
        mio.executemany, mio.query_all = cap.executemany, cap.query_all
        try:
            n = mio.upsert_ohlc(REAL_SYMBOL, rows)
        finally:
            mio.executemany, mio.query_all = orig_executemany, orig_query_all

        assert n == len(rows)
        assert cap.executemany_calls, "upsert_ohlc() made no executemany() calls despite real bars"
        for sql, row in cap.executemany_calls[:5]:
            symbol, date, open_, high, low, close, volume = row
            assert symbol == REAL_SYMBOL
            assert date, "stock_ohlcv.date is empty"
            assert_numeric_and_finite(close, context="stock_ohlcv.close")
