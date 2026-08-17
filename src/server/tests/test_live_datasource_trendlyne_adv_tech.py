"""
live_datasource test for trendlyne_adv_tech_fetcher.py (see CLAUDE.md "Adding a new data
source"). Same pattern as test_live_datasource_trendlyne_price_analysis.py.

RELIANCE (tlid=1127) chosen for the same reason as the price-analysis test — a real,
actively-covered stock whose Trendlyne advanced-technical page won't return empty.
"""

import sqlite3
import sys
import os

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
from trendlyne_adv_tech_fetcher import fetch_adv_tech, extract_features, upsert_row, backfill_technical_signals
from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"
REAL_TLID = "1127"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://trendlyne.com/",
}


def _make_test_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE trendlyne_adv_tech_daily (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            ma_bull INTEGER, ma_bear INTEGER, osc_bull INTEGER, osc_bear INTEGER,
            rsi REAL, macd REAL, macd_hist REAL, adx REAL, atr REAL, mfi REAL, cci REAL,
            roc_21 REAL, roc_125 REAL, william REAL, uo REAL, momentum_score REAL,
            current_price REAL, pivot REAL, r1 REAL, s1 REAL, pivot_dist_pct REAL,
            ret_1d REAL, ret_1w REAL, ret_1m REAL, ret_3m REAL, ret_6m REAL,
            ret_1y REAL, ret_3y REAL, ret_5y REAL,
            delivery_pct_day REAL, delivery_pct_week REAL, delivery_pct_1m REAL, delivery_pct_6m REAL,
            vol_avg_day REAL, vol_avg_week REAL, vol_avg_1m REAL,
            beta_1m REAL, beta_3m REAL, beta_1y REAL, beta_3y REAL,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT,
            ma_bull_frac REAL, osc_bull_frac REAL, adx_tl REAL, atr_pct_tl REAL, mfi_tl REAL,
            pivot_dist_pct_tl REAL, delivery_avg_1m_tl REAL, beta_1y_tl REAL,
            ret_1m_tl REAL, ret_3m_tl REAL, ret_6m_tl REAL, ret_1y_tl REAL
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestTrendlyneAdvTechLiveDataSource:
    def test_real_stock_returns_usable_technical_features(self):
        """Steps 1-3: hit the real URL, parse with the real function, assert the response
        is non-empty and at least the core oscillator features are real finite numbers."""
        session = requests.Session()
        session.headers.update(HEADERS)
        params = fetch_adv_tech(REAL_TLID, session)
        assert_non_empty_response(params, f"fetch_adv_tech(tlid={REAL_TLID})")

        feat = extract_features(params)
        assert_non_empty_response(feat, f"extract_features for {REAL_SYMBOL}")

        for key in ("rsi", "adx"):
            if feat.get(key) is not None:
                assert_numeric_and_finite(feat[key], f"extract_features.{key}")

    def test_real_stock_stores_ml_usable_row_and_backfills_technical_signals(self):
        """Steps 4-5: write through the real DB-write functions into a throwaway DB, then
        read back and validate the stored row is ML-usable. Also exercises
        backfill_technical_signals with a real anchor date -- the exact code path fixed
        this session for the date-anchor bug (Tuesday trendlyne-midweek batch)."""
        session = requests.Session()
        session.headers.update(HEADERS)
        params = fetch_adv_tech(REAL_TLID, session)
        assert params is not None
        feat = extract_features(params)
        assert feat

        conn = _make_test_db()
        today_str = "2026-01-01"  # arbitrary fixed date, not date.today() -- this fetcher's
        # own functions take the anchor as a plain string param, no internal date.today() call
        upsert_row(REAL_SYMBOL, today_str, feat, conn)

        row = conn.execute(
            "SELECT * FROM trendlyne_adv_tech_daily WHERE symbol = ? AND date = ?",
            (REAL_SYMBOL, today_str),
        ).fetchone()
        assert row is not None, "trendlyne_adv_tech_daily row was not stored"
        row = dict(row)
        if feat.get("rsi") is not None:
            assert_numeric_and_finite(row["rsi"], "trendlyne_adv_tech_daily.rsi")

        # Regression coverage for the date-anchor bug fixed this session: seed a
        # pre-existing technical_signals row for the anchor date (standing in for the
        # grid-ensurer's row) and confirm the value actually lands, not gets nulled.
        conn.execute(
            "INSERT INTO technical_signals (symbol, date) VALUES (?, ?)",
            (REAL_SYMBOL, today_str),
        )
        conn.commit()
        backfill_technical_signals(REAL_SYMBOL, today_str, feat, conn)

        ts_row = dict(conn.execute(
            "SELECT * FROM technical_signals WHERE symbol = ? AND date = ?",
            (REAL_SYMBOL, today_str),
        ).fetchone())
        if feat.get("adx") is not None:
            assert_numeric_and_finite(ts_row["adx_tl"], "technical_signals.adx_tl")
            assert ts_row["adx_tl"] == feat["adx"]
