"""
live_datasource test for trendlyne_price_analysis_fetcher.py (see CLAUDE.md "Adding a new
data source" — every fetcher hitting an external URL needs one of these). Same pattern as
test_live_datasource_trendlyne_screener.py / test_live_datasource_et_stats.py.

RELIANCE (tlid=1127) is a real, long-lived, actively-covered stock — chosen because its
Trendlyne price-performance-analysis page is very unlikely to ever return an empty body.
"""

import sqlite3
import sys
import os
from datetime import date

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
from trendlyne_price_analysis_fetcher import _fetch, extract_features, upsert_row, backfill_technical_signals
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
        CREATE TABLE trendlyne_price_analysis (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            stock_ret_1m REAL, stock_ret_3m REAL, stock_ret_6m REAL,
            stock_ret_1y REAL, stock_ret_3y REAL, stock_ret_5y REAL,
            nifty_ret_1m REAL, nifty_ret_3m REAL, nifty_ret_6m REAL,
            nifty_ret_1y REAL, nifty_ret_3y REAL, nifty_ret_5y REAL,
            ind_ret_1m REAL, ind_ret_3m REAL, ind_ret_6m REAL,
            alpha_nifty_1m REAL, alpha_nifty_3m REAL, alpha_nifty_6m REAL,
            alpha_ind_1m REAL, alpha_ind_3m REAL,
            seasonal_jan REAL, seasonal_feb REAL, seasonal_mar REAL, seasonal_apr REAL,
            seasonal_may REAL, seasonal_jun REAL, seasonal_jul REAL, seasonal_aug REAL,
            seasonal_sep REAL, seasonal_oct REAL, seasonal_nov REAL, seasonal_dec REAL,
            dist_3m_high_pct REAL, dist_3m_low_pct REAL,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT,
            tl_vs_nifty_1m REAL, tl_vs_nifty_3m REAL, tl_vs_nifty_6m REAL,
            tl_vs_ind_1m REAL, tl_vs_ind_3m REAL,
            tl_seasonal_month_5y REAL, tl_dist_3m_high_pct REAL, tl_dist_3m_low_pct REAL
        );
    """)
    return conn


@pytest.mark.live_datasource
class TestTrendlynePriceAnalysisLiveDataSource:
    def test_real_stock_returns_usable_alpha_features(self):
        """Steps 1-3 of the pattern: hit the real URL, parse with the real function, assert
        the response is non-empty and the alpha-vs-benchmark features are real finite numbers."""
        session = requests.Session()
        session.headers.update(HEADERS)
        body = _fetch(REAL_TLID, session)
        assert_non_empty_response(body, f"_fetch(tlid={REAL_TLID})")

        feat = extract_features(body, date.today())
        assert_non_empty_response(feat, f"extract_features for {REAL_SYMBOL}")

        # At least one benchmark-relative alpha feature must have actually parsed --
        # this is the exact feature family this fetcher exists to produce.
        alpha_keys = [k for k in feat if k.startswith("alpha_")]
        assert alpha_keys, f"no alpha_* features extracted for {REAL_SYMBOL} — response shape may have changed"
        for k in alpha_keys:
            assert_numeric_and_finite(feat[k], f"extract_features.{k}")

    def test_real_stock_stores_ml_usable_row_and_backfills_technical_signals(self):
        """Steps 4-5: write through the real DB-write functions into a throwaway DB, then
        read back and validate the stored row is ML-usable — catches storage/type bugs on
        top of parse bugs. Also exercises backfill_technical_signals with a real `anchor_str`-
        shaped date (the exact code path fixed this session for the date-anchor bug)."""
        session = requests.Session()
        session.headers.update(HEADERS)
        body = _fetch(REAL_TLID, session)
        assert body is not None
        feat = extract_features(body, date.today())
        assert feat

        conn = _make_test_db()
        today_str = date.today().isoformat()
        upsert_row(REAL_SYMBOL, today_str, feat, conn)

        row = conn.execute(
            "SELECT * FROM trendlyne_price_analysis WHERE symbol = ? AND date = ?",
            (REAL_SYMBOL, today_str),
        ).fetchone()
        assert row is not None, "trendlyne_price_analysis row was not stored"
        row = dict(row)
        for col in ("alpha_nifty_1m", "alpha_nifty_3m"):
            if feat.get(col) is not None:
                assert_numeric_and_finite(row[col], f"trendlyne_price_analysis.{col}")

        # Regression coverage for the date-anchor bug fixed this session: seed a
        # pre-existing technical_signals row for `today_str` (standing in for the
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
        if feat.get("alpha_nifty_1m") is not None:
            assert_numeric_and_finite(ts_row["tl_vs_nifty_1m"], "technical_signals.tl_vs_nifty_1m")
            assert ts_row["tl_vs_nifty_1m"] == feat["alpha_nifty_1m"]
