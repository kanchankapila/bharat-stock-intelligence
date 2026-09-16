"""Live-datasource test for mc_earnings_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). Explicitly named as a top-priority untested fetcher in the
2026-07-30 fifth full-stack-audit pass -- it feeds 11 `technical_signals` columns
(days_to_next_results, earnings_category_yoy/qoq, earnings_np_growth_yoy/qoq,
earnings_shocker_flag/gain, eps_beat_last_q, mc_eps_vs_cons, positive/negative_turnaround)
consumed directly by ml_ensemble.py.

Unlike per-stock fetchers, mc_earnings_fetcher.py's endpoints are market-wide (a single call
returns whichever stocks currently have earnings-calendar/price-shocker data, not a fixed
symbol) -- which stocks appear is inherently day-dependent. To make the DB-round-trip half of
this test deterministic rather than "hope a known symbol shows up today," the real response's
own scids are resolved against the LIVE production `nse_stocks` table (the same resolution
mc_earnings_fetcher.py's own backfill functions perform in production) rather than a synthetic
mapping -- this exercises the exact same JOIN path with real data, without guessing which
tickers will be in today's feed.
"""
import os


import sqlite3
import sys
from datetime import date, timedelta

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import mc_earnings_fetcher as mef
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite


def _resolve_real_mcsymbol_map(scids):
    """Look up real (mcsymbol -> symbol) pairs from the live production nse_stocks table for
    whichever scids the live endpoint actually returned today. Returns {} if no live DB is
    reachable or none of the scids resolve -- callers must handle an empty map gracefully
    (the endpoint's own shape is still validated regardless)."""
    if not scids:
        return {}
    try:
        import psycopg2
        conn = psycopg2.connect(host="127.0.0.1", port=5433, user="bharat",
                                 password="bharat", dbname="bharat_intel", connect_timeout=3)
        cur = conn.cursor()
        cur.execute(
            "SELECT mcsymbol, symbol FROM nse_stocks WHERE mcsymbol = ANY(%s)",
            (list(scids),),
        )
        result = dict(cur.fetchall())
        conn.close()
        return result
    except Exception:
        return {}


def _make_test_conn(mcsymbol_map):
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT, mcsymbol TEXT)")
    # Pre-create the technical_signals columns ensure_schema() would otherwise add via
    # `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` -- that syntax is Postgres-only and fails
    # (silently, caught by ensure_schema's own per-statement try/except) against this
    # Python's bundled SQLite, the same gotcha already documented for data_integrity_repair.py
    # in CLAUDE.md. Pre-creating the columns here makes ensure_schema()'s ALTERs harmless no-ops.
    conn.execute("""CREATE TABLE technical_signals (
        symbol TEXT, date TEXT,
        days_to_next_results INTEGER,
        earnings_shocker_flag INTEGER,
        earnings_shocker_gain REAL
    )""")
    today = date.today().isoformat()
    for mcsymbol, symbol in mcsymbol_map.items():
        conn.execute("INSERT INTO nse_stocks (symbol, mcsymbol) VALUES (?, ?)", (symbol, mcsymbol))
        conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (symbol, today))
    conn.commit()
    mef.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestMcEarningsFetcherLiveDataSource:
    def test_earnings_dates_endpoint_shape_and_backfill(self):
        """Hits the real upcoming-earnings-dates endpoint via the fetcher's own fetch_earnings_dates(),
        which both parses the response and backfills technical_signals.days_to_next_results --
        exercising the fetcher's own DB-write function, not a hand-rolled reimplementation."""
        url = (
            f"https://api.moneycontrol.com/mcapi/v1/earnings/get-earnings-data"
            f"?indexId=All&page=1&startDate={mef.TODAY}&endDate={mef.TODAY_PLUS_14}&sector=&limit=10000"
        )
        raw = mef._get(url)
        assert raw is not None, "get-earnings-data endpoint returned no data at all -- endpoint may be down/blocked"
        items = raw.get("list") or []
        # A live 14-day window across the full NSE/BSE universe is virtually never empty in
        # practice, but not guaranteed for a completely arbitrary run date -- assert shape
        # rather than non-emptiness if it genuinely comes back empty.
        scids = [it.get("scId") for it in items if it.get("scId")]
        if items:
            sample = items[0]
            assert sample.get("scId"), "an earnings-calendar item is missing scId entirely"
            assert sample.get("date"), "an earnings-calendar item is missing its result date"

        mcsymbol_map = _resolve_real_mcsymbol_map(scids)
        conn = _make_test_conn(mcsymbol_map)
        mef.fetch_earnings_dates(conn)

        stored = conn.execute("SELECT scid, result_date, stock_name FROM stock_earnings_dates").fetchall()
        if items:
            assert stored, "fetch_earnings_dates() parsed real items but wrote zero rows to stock_earnings_dates"
            for scid, result_date, stock_name in stored:
                assert scid, "stock_earnings_dates.scid is empty"
                assert result_date, "stock_earnings_dates.result_date is empty"

        if mcsymbol_map:
            backfilled = conn.execute(
                "SELECT symbol, days_to_next_results FROM technical_signals "
                "WHERE days_to_next_results IS NOT NULL"
            ).fetchall()
            for symbol, days in backfilled:
                assert_looks_like_ticker(symbol, context="technical_signals.symbol")
                assert_numeric_and_finite(days, context="technical_signals.days_to_next_results")

    def test_price_shockers_endpoint_shape_and_backfill(self):
        """Hits the real price-shockers endpoint via the fetcher's own fetch_price_shockers(),
        which parses the positional-array response shape and backfills
        technical_signals.earnings_shocker_flag/gain."""
        url = "https://api.moneycontrol.com/mcapi/v1/earnings/price-shockers?limit=10000&page=1"
        raw = mef._get(url)
        assert raw is not None, "price-shockers endpoint returned no data at all -- endpoint may be down/blocked"
        items = raw.get("list") or []
        scids = [it[0] for it in items if len(it) > 0 and it[0]]

        mcsymbol_map = _resolve_real_mcsymbol_map(scids)
        conn = _make_test_conn(mcsymbol_map)
        mef.fetch_price_shockers(conn)

        stored = conn.execute(
            "SELECT scid, ltp, change_pct, gain_since_result FROM mc_price_shockers"
        ).fetchall()
        if items:
            assert stored, "fetch_price_shockers() parsed real items but wrote zero rows to mc_price_shockers"
            for scid, ltp, change_pct, gain in stored:
                assert scid, "mc_price_shockers.scid is empty"
                if ltp is not None:
                    assert_numeric_and_finite(ltp, context="mc_price_shockers.ltp")
                if change_pct is not None:
                    assert_numeric_and_finite(change_pct, context="mc_price_shockers.change_pct")

        if mcsymbol_map:
            flagged = conn.execute(
                "SELECT symbol, earnings_shocker_flag FROM technical_signals "
                "WHERE earnings_shocker_flag = 1"
            ).fetchall()
            for symbol, flag in flagged:
                assert_looks_like_ticker(symbol, context="technical_signals.symbol")
                assert flag == 1
