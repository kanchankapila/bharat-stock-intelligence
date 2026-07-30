"""
Concrete live_datasource test for trendlyne_fno_activity_fetcher.py -- a new market-wide
F&O activity screener endpoint promoted 2026-07-30 from a stale-dated URL captured in
updated_urls.json. Follows the pattern documented in CLAUDE.md's "Adding a new data source"
rule: hit the real endpoint, parse with the fetcher's own function, write through its own
DB-write function into a throwaway DB, assert the stored rows are ML-usable.

No hardcoded stock/expiry here -- the whole point of this fetcher is resolving the CURRENT
nearest monthly expiry live (see _get_nearest_monthly_expiry's docstring for why NIFTY's own
nearest expiry is the wrong date to use for this cross-market endpoint).
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import trendlyne_fno_activity_fetcher as fno_activity
from live_datasource_helpers import (
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_stored_row_ml_usable,
)


def _make_test_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    fno_activity.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestTrendlyneFnoActivityLiveDataSource:
    def test_nearest_monthly_expiry_resolves_to_a_real_future_date(self):
        """Guards the core fix: this must resolve to the shared monthly expiry, not an
        index-only weekly date most stocks don't trade on."""
        from datetime import date
        expiry = fno_activity._get_nearest_monthly_expiry()
        assert expiry >= date.today().isoformat(), "resolved expiry must not be in the past"

    def test_nse_official_and_nt_fno_expiry_fallback_agree(self):
        """Added 2026-07-30: _get_nearest_monthly_expiry() now tries NSE's own official
        futures-expiry list first (load-distributes away from sole reliance on NiftyTrader's
        nt_fno_expiry), falling back to the mode-based nt_fno_expiry lookup if that fails.
        Confirms both sources currently agree -- if they ever diverge, that's a real
        data-quality signal worth investigating, not just picking one silently."""
        nse_expiry = fno_activity._get_nse_official_monthly_expiry()
        assert nse_expiry is not None, "NSE official expiry lookup should succeed live"
        fallback_expiry = fno_activity._get_nearest_monthly_expiry()
        assert nse_expiry == fallback_expiry, (
            f"NSE official ({nse_expiry}) and the resolved expiry ({fallback_expiry}) "
            f"disagree -- expected NSE to be preferred and both sources to currently match"
        )

    def test_real_screener_returns_real_tickers_with_expected_shape(self):
        expiry = fno_activity._get_nearest_monthly_expiry()
        body = fno_activity.fetch_activity(expiry, "oi-gainers")
        assert_non_empty_response(body, f"fetch_activity(oi-gainers, {expiry})")

        rows = fno_activity.parse_activity(body, "2026-01-01", expiry, "oi-gainers")
        assert_non_empty_response(rows, "parse_activity(oi-gainers)")

        # A cross-market screener at the monthly expiry must cover more than one symbol --
        # this is the exact regression this fetcher was fixed for (an earlier version using
        # NIFTY's own nearest expiry returned 298/298 rows for symbol=NIFTY only).
        distinct_symbols = {r[0] for r in rows}
        assert len(distinct_symbols) > 5, (
            f"expected a cross-market spread of symbols, got only {distinct_symbols} -- "
            f"likely resolved to an index-only weekly expiry instead of the monthly series"
        )
        for row in rows[:10]:
            assert_looks_like_ticker(row[0], "trendlyne_fno_activity symbol")

    def test_real_screener_stores_ml_usable_rows(self):
        expiry = fno_activity._get_nearest_monthly_expiry()
        body = fno_activity.fetch_activity(expiry, "oi-gainers")
        assert body is not None
        rows = fno_activity.parse_activity(body, "2026-01-01", expiry, "oi-gainers")
        assert rows

        conn = _make_test_db()
        cur = conn.cursor()
        cur.executemany("""
            INSERT INTO trendlyne_fno_activity
                (symbol, date, expiry, screen_type, rank, option_type, strike,
                 ltp, day_change_pct, volume, volume_chg_pct, ttv,
                 oi, oi_change, oi_change_pct, iv, iv_change_pct, spot,
                 delta, gamma, theta, vega, rho, buildup)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, rows)
        conn.commit()

        stored = cur.execute("SELECT * FROM trendlyne_fno_activity").fetchall()
        assert len(stored) == len(rows)
        for row in stored[:10]:
            assert_stored_row_ml_usable(
                dict(row),
                numeric_cols=["strike", "oi", "oi_change_pct", "delta"],
                ticker_cols=["symbol"],
                context="trendlyne_fno_activity",
            )
