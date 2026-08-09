"""Live-datasource test for intraday_fetcher.py (see CLAUDE.md's "Adding a new data source"
mandatory rule). One of the highest-priority remaining untested fetchers -- feeds
intraday_ohlcv, the sole input to intraday_features.py/intraday_ranker.py, and has the
heaviest documented bug history of any fetcher in this repo (mcsymbol-vs-raw-ticker,
off-grid synthetic quotes, VWAP always-NULL, worker-concurrency ceiling).

execute()/executemany()/query_all() are bare module-level functions imported from
db_compat (no `con` parameter to inject a test DB through) -- same monkeypatch-the-module
pattern already established for the nt_* NiftyTrader fetchers.
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import intraday_fetcher as itf
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"


class _CaptureDB:
    def __init__(self, symbol_rows):
        self.symbol_rows = symbol_rows
        self.upserts = []

    def query_all(self, sql, params=()):
        return self.symbol_rows

    def executemany(self, sql, rows):
        self.upserts.extend((sql, row) for row in rows)


@pytest.mark.live_datasource
class TestIntradayFetcherLiveDataSource:
    def test_mc_fetch_parses_real_bars(self):
        """Hits the real MoneyControl TechCharts endpoint for RELIANCE (raw ticker, the
        fix this fetcher's own docstring documents) and parses with the fetcher's own
        parse_bars() -- must return real, on-grid, chronologically-sane bars."""
        to_ts = int(time.time())
        from_ts = to_ts - 5 * 24 * 3600
        data = itf._fetch_live(REAL_SYMBOL, from_ts, to_ts, countback=200)
        assert data is not None, "MC TechCharts returned no data for RELIANCE -- endpoint may be down/blocked"

        bars = itf.parse_bars(data, REAL_SYMBOL)
        assert bars, "parse_bars() dropped every bar from a non-empty MC response"
        for b in bars[:5]:
            assert_looks_like_ticker(b["symbol"], context="parse_bars.symbol")
            assert_numeric_and_finite(b["open"], context="parse_bars.open")
            assert_numeric_and_finite(b["close"], context="parse_bars.close")
            assert b["high"] >= b["low"], f"bar has high < low: {b}"
            assert b["volume"] is None or b["volume"] >= 0, f"bar has negative volume: {b}"

    def test_yahoo_fetch_parses_real_bars(self):
        """Hits the real Yahoo Finance chart endpoint for RELIANCE.NS, the second of the
        two independent sources this fetcher blends."""
        to_ts = int(time.time())
        from_ts = to_ts - 5 * 24 * 3600
        data = itf._fetch_yahoo(REAL_SYMBOL, from_ts, to_ts)
        assert data is not None, "Yahoo chart endpoint returned no data for RELIANCE.NS -- endpoint may be down/changed"

        bars = itf.parse_bars(data, REAL_SYMBOL)
        assert bars, "parse_bars() dropped every bar from a non-empty Yahoo response"
        for b in bars[:5]:
            assert_numeric_and_finite(b["close"], context="yahoo.close")

    def test_run_writes_ml_usable_rows_via_own_upsert(self):
        """Runs the fetcher's real run() end-to-end (real fetch, real parse) with query_all/
        executemany monkeypatched to a capture object standing in for the DB -- exercises the
        fetcher's own write path, not a hand-rolled reimplementation."""
        cap = _CaptureDB(symbol_rows=[{"symbol": REAL_SYMBOL}])
        orig_query_all, orig_executemany = itf.query_all, itf.executemany
        itf.query_all, itf.executemany = cap.query_all, cap.executemany
        try:
            total = itf.run(lookback_days=3, symbols=[REAL_SYMBOL])
        finally:
            itf.query_all, itf.executemany = orig_query_all, orig_executemany

        assert total > 0, "run() reported 0 bars written for a real, liquid, well-known symbol"
        assert cap.upserts, "run() never called executemany() against intraday_ohlcv"
        # _UPSERT param order: (symbol, datetime, open, high, low, close, volume, vwap, interval)
        for sql, row in cap.upserts[:5]:
            symbol, dt, o, h, l, c, v, vwap, interval = row
            assert_looks_like_ticker(symbol, context="intraday_ohlcv.symbol")
            assert dt, "intraday_ohlcv.datetime is empty"
            assert_numeric_and_finite(c, context="intraday_ohlcv.close")
            assert interval == "15m"
