"""Live-datasource test for index_membership_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). This fetcher has real, documented production incident history
(Finding #110, 2026-07-30 fifth audit pass): its date-anchor guard nulled every historical
is_nifty50/.../nifty_tier column on every weekly run for weeks before being fixed to anchor
on the last completed trading session instead of datetime.now().
"""
import os

os.environ["USE_POSTGRES"] = "false"

import sqlite3
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import index_membership_fetcher as imf
from live_datasource_helpers import assert_looks_like_ticker


def _make_test_conn():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY)")
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date TEXT)")
    conn.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT)")
    # Seed a handful of real Nifty 50 constituents so fetch_index_symbols' real response
    # actually matches at least one row in the throwaway universe.
    for sym in ("RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK"):
        conn.execute("INSERT INTO nse_stocks (symbol) VALUES (?)", (sym,))
        conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)",
                     (sym, date.today().isoformat()))
    # Anchor stock_ohlcv's MAX(date) to today so logical_write_floor()'s guard matches.
    conn.execute("INSERT INTO stock_ohlcv (symbol, date) VALUES (?, ?)",
                 ("RELIANCE", date.today().isoformat()))
    conn.commit()
    imf.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestIndexMembershipLiveDataSource:
    def test_fetch_nifty50_returns_real_symbols(self):
        """Hits the real NSE archives CSV for the Nifty 50 constituent list via the
        fetcher's own fetch_index_symbols() -- the single most well-known, stable index
        list, least likely to be empty on any given day."""
        sess = imf._nse_session()
        symbols = imf.fetch_index_symbols(sess, "NIFTY50", imf.INDICES["NIFTY50"])
        assert symbols, "fetch_index_symbols() returned zero Nifty 50 constituents -- NSE archives endpoint may be down/changed"
        assert 40 <= len(symbols) <= 60, f"Nifty 50 constituent count {len(symbols)} outside plausible range"
        # A real, extremely well-known constituent should be present (guards against a
        # column-selection bug that returns some other column's values as "symbols").
        assert "RELIANCE" in symbols, f"RELIANCE missing from parsed Nifty 50 list: {sorted(symbols)[:10]}..."
        for sym in list(symbols)[:10]:
            assert_looks_like_ticker(sym, context="fetch_index_symbols.NIFTY50")

    def test_update_and_backfill_write_ml_usable_flags(self):
        """Writes real fetched membership through the fetcher's own update_nse_stocks() +
        backfill_technical_signals() -- exercising the exact write path production uses,
        into a throwaway DB pre-seeded with real constituent symbols."""
        sess = imf._nse_session()
        symbols = imf.fetch_index_symbols(sess, "NIFTY50", imf.INDICES["NIFTY50"])
        assert symbols, "fetch_index_symbols() returned nothing -- cannot exercise the write path"

        conn = _make_test_conn()
        counts = imf.update_nse_stocks(conn, {"NIFTY50": symbols})
        assert counts["NIFTY50"] > 0, "update_nse_stocks() updated zero rows even though seeded universe overlaps the real Nifty 50 list"

        ts_updated = imf.backfill_technical_signals(conn)
        assert ts_updated > 0, "backfill_technical_signals() updated zero technical_signals rows -- the date-anchor guard may be broken again (Finding #110)"

        row = conn.execute(
            "SELECT symbol, is_nifty50, nifty_tier FROM technical_signals WHERE symbol = 'RELIANCE'"
        ).fetchone()
        symbol, is_nifty50, nifty_tier = row
        assert_looks_like_ticker(symbol, context="technical_signals.symbol")
        assert is_nifty50 == 1, "RELIANCE not flagged is_nifty50=1 after a real Nifty 50 sync"
        assert nifty_tier == 50, f"RELIANCE's nifty_tier should be 50, got {nifty_tier}"
        conn.close()
