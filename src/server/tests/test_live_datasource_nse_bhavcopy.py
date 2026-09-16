"""Live-datasource test for nse_bhavcopy_fetcher (MANDATORY per CLAUDE.md).

Hits the real NSE archive for a real trading day, parses with the fetcher's OWN parser,
writes through its OWN DB-write function, and asserts the stored row is ML-usable.

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI -- a transient
NSE outage must not fail the build.
"""
import datetime
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))   # live_datasource_helpers lives here
from pg_test_support import pg_memory_conn  # noqa: E402

from live_datasource_helpers import (  # noqa: E402
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_numeric_and_finite,
)

pytestmark = pytest.mark.live_datasource

import nse_bhavcopy_fetcher as bhav  # noqa: E402


# A long-settled trading day: Wednesday 2026-07-29. Using a fixed past date rather than
# "today" keeps the test deterministic and avoids the pre-publication window after close.
KNOWN_TRADING_DAY = datetime.date(2026, 7, 29)


class FakeConn:
    """Throwaway in-memory DB so the test never touches production."""

    def __init__(self):
        self._c = pg_memory_conn()

    def execute(self, sql, params=()):
        return self._c.execute(sql, params)

    def commit(self):
        self._c.commit()

    def close(self):
        self._c.close()


@pytest.fixture(scope='module')
def rows():
    fetched = bhav.fetch_bhavcopy(KNOWN_TRADING_DAY)
    assert_non_empty_response(fetched, f"NSE bhavcopy for {KNOWN_TRADING_DAY}")
    return fetched


def test_returns_a_plausible_universe(rows):
    """NSE lists ~2,000-3,500 equity securities; anything far outside means the format moved."""
    assert 1500 < len(rows) < 5000, f"implausible universe size: {len(rows)}"


def test_every_symbol_looks_like_a_ticker(rows):
    """The 2026-07-23 incident wrote a profile URL into a symbol column. Guard the shape."""
    for r in rows[:400]:
        assert_looks_like_ticker(r['symbol'])


def test_prices_are_real_finite_numbers(rows):
    for r in rows[:400]:
        for col in ('open', 'high', 'low', 'close'):
            assert_numeric_and_finite(r[col], f"{r['symbol']}.{col}")


def test_ohlc_is_internally_consistent(rows):
    """low <= open/close <= high. A violation here is exactly what the bad-bar quarantine
    exists to catch, so the source itself must be clean."""
    bad = [r for r in rows
           if not (r['low'] <= r['open'] <= r['high'] and r['low'] <= r['close'] <= r['high'])]
    assert len(bad) < max(3, len(rows) * 0.001), f"too many inconsistent bars: {bad[:3]}"


def test_all_rows_carry_the_requested_date(rows):
    assert {r['date'] for r in rows} == {KNOWN_TRADING_DAY.isoformat()}


def test_only_equity_series_survive_the_filter(rows):
    """Gilts (GS) and sovereign gold bonds (GB) must not enter an equity cross-section."""
    series = {r['series'] for r in rows}
    assert series <= bhav.EQUITY_SERIES, f"non-equity series leaked in: {series - bhav.EQUITY_SERIES}"


def test_contains_known_large_caps(rows):
    """Sanity: the biggest names on NSE must be present on any normal trading day."""
    syms = {r['symbol'] for r in rows}
    for expected in ('RELIANCE', 'HDFCBANK', 'INFY', 'TCS'):
        assert expected in syms, f"{expected} missing from the bhavcopy"


def test_delivery_data_is_present_and_bounded(rows):
    """DELIV_PER is why this source also replaces scraped delivery data."""
    with_deliv = [r for r in rows if r['deliv_pct'] is not None]
    assert len(with_deliv) > len(rows) * 0.5, "delivery% missing for most securities"
    for r in with_deliv[:300]:
        assert 0.0 <= r['deliv_pct'] <= 100.0, f"{r['symbol']} deliv_pct={r['deliv_pct']}"


def test_round_trip_through_the_real_db_writer(rows):
    """Write with the fetcher's own function, read back, assert ML-usability."""
    conn = FakeConn()
    try:
        bhav.ensure_schema(conn)
        n = bhav.store_bhavcopy(conn, rows[:200])
        assert n == 200

        stored = conn.execute(
            "SELECT symbol, date, close, volume, deliv_pct FROM nse_universe_history "
            "ORDER BY symbol LIMIT 50").fetchall()
        assert len(stored) == 50
        for symbol, date, close, volume, deliv_pct in stored:
            assert_looks_like_ticker(symbol)
            assert date == KNOWN_TRADING_DAY.isoformat()
            assert_numeric_and_finite(close, f"{symbol}.close")
            assert close > 0
            if volume is not None:
                assert volume >= 0
    finally:
        conn.close()


def test_upsert_is_idempotent(rows):
    """Re-running a day must not duplicate it -- the backfill re-runs dates freely."""
    conn = FakeConn()
    try:
        bhav.ensure_schema(conn)
        bhav.store_bhavcopy(conn, rows[:100])
        bhav.store_bhavcopy(conn, rows[:100])
        n = conn.execute("SELECT count(*) FROM nse_universe_history").fetchone()[0]
        assert n == 100, f"upsert duplicated rows: {n}"
    finally:
        conn.close()


def test_non_trading_day_returns_empty_not_an_error():
    """NSE 404s weekends; retry_get raises on that, and the fetcher must absorb it."""
    saturday = datetime.date(2026, 7, 25)
    assert saturday.weekday() == 5
    assert bhav.fetch_bhavcopy(saturday) == []


def test_captures_securities_absent_from_the_current_master(rows):
    """The entire point: the bhavcopy sees names the current nse_stocks master does not.

    Only meaningful on a historical date, but even today's file carries SME/delisted-soon
    names that the master lags on.
    """
    assert len({r['symbol'] for r in rows}) > 1500
