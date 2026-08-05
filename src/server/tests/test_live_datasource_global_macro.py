"""Live-datasource test for global_macro_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). connect() is called directly inside fetch_macro()/
fetch_bond_yields() (no injectable con parameter) -- monkeypatched to return a throwaway
in-memory sqlite connection instead of touching a real DB file. TICKERS is temporarily
narrowed to one symbol so the test doesn't hammer yfinance for all 8 tickers.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import global_macro_fetcher as gmf
from live_datasource_helpers import assert_numeric_and_finite


class _UnclosableConn:
    """Proxies a real sqlite3.Connection but no-ops close() -- the fetcher owns the
    connection lifecycle and calls con.close() when done; sqlite3.Connection's close
    attribute is read-only (C extension type) so it can't be monkeypatched directly, hence
    this thin wrapper instead."""
    def __init__(self, real):
        self._real = real

    def close(self):
        pass

    def __getattr__(self, name):
        return getattr(self._real, name)


def _make_conn():
    import sqlite3
    conn = sqlite3.connect(":memory:")
    conn.execute("""CREATE TABLE macro_asset_prices (
        date TEXT, symbol TEXT, close REAL, ret_1d REAL, ret_5d REAL, fetched_at TEXT,
        PRIMARY KEY (date, symbol)
    )""")
    conn.execute("""CREATE TABLE macro_indicators (
        indicator_name TEXT, date TEXT, value REAL, PRIMARY KEY (indicator_name, date)
    )""")
    conn.execute("""CREATE TABLE stock_ohlcv (
        symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER,
        PRIMARY KEY (symbol, date)
    )""")
    return _UnclosableConn(conn)


@pytest.mark.live_datasource
class TestGlobalMacroFetcherLiveDataSource:
    def test_fetch_macro_writes_ml_usable_rows(self):
        """Hits real yfinance for one real, always-available ticker (NIFTY50, ^NSEI) via the
        fetcher's own fetch_macro(), with connect() monkeypatched to a throwaway sqlite
        connection instead of a real DB file."""
        captured = {}
        orig_connect = gmf.connect
        orig_tickers = dict(gmf.TICKERS)
        gmf.connect = lambda: captured.setdefault("conn", _make_conn()) or captured["conn"]
        gmf.TICKERS = {"^NSEI": "NIFTY50"}
        try:
            gmf.fetch_macro(days=10)
        finally:
            gmf.connect = orig_connect
            gmf.TICKERS = orig_tickers

        conn = captured.get("conn")
        assert conn is not None, "fetch_macro() never called connect()"
        rows = conn.execute(
            "SELECT date, symbol, close FROM macro_asset_prices WHERE symbol = 'NIFTY50'"
        ).fetchall()
        assert rows, "fetch_macro() wrote zero rows for NIFTY50 -- yfinance may be down/rate-limited"
        for date, symbol, close in rows:
            assert symbol == "NIFTY50"
            assert_numeric_and_finite(close, context="macro_asset_prices.close")

        ohlcv_rows = conn.execute("SELECT close FROM stock_ohlcv WHERE symbol = 'NIFTY50'").fetchall()
        assert ohlcv_rows, "fetch_macro() should also write NIFTY50 into stock_ohlcv (OHLCV_WRITE_LABELS)"
        conn.close()

    def test_fetch_bond_yields_writes_ml_usable_rows(self):
        """Hits the real MoneyControl global bond-yields endpoint via the fetcher's own
        fetch_bond_yields()."""
        captured = {}
        orig_connect = gmf.connect
        gmf.connect = lambda: captured.setdefault("conn", _make_conn()) or captured["conn"]
        try:
            gmf.fetch_bond_yields()
        finally:
            gmf.connect = orig_connect

        conn = captured.get("conn")
        assert conn is not None, "fetch_bond_yields() never called connect() -- endpoint may be down"
        rows = conn.execute("SELECT symbol, close FROM macro_asset_prices").fetchall()
        assert rows, "fetch_bond_yields() wrote zero rows -- bond-yields endpoint may be down/changed"
        for symbol, close in rows:
            assert symbol in gmf._BOND_NAME_MAP.values() or symbol == "INDIA_US_SPREAD"
            assert_numeric_and_finite(close, context=f"macro_asset_prices.{symbol}")
        conn.close()
