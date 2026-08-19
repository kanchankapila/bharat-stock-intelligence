"""Live-datasource test for trendlyne_overview_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). Heavily documented bug history in this repo (silent
crash-on-con=None in worker threads, look-ahead-bias in the shareholding floor) but never
had its own live_datasource test. RELIANCE/tlid=1127 -- same convention already used by
test_live_datasource_trendlyne_adv_tech.py / test_live_datasource_trendlyne_price_analysis.py.
"""
import os


import sqlite3
import sys
from datetime import date

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import trendlyne_overview_fetcher as tof
from live_datasource_helpers import assert_looks_like_ticker, assert_numeric_and_finite

REAL_SYMBOL = "RELIANCE"
REAL_TLID = "1127"


def _make_test_conn():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date TEXT)")
    conn.execute("""CREATE TABLE technical_signals (
        symbol TEXT, date TEXT,
        analyst_upside_pct REAL, analyst_count INTEGER, analyst_buy_pct REAL,
        roe_annual REAL, roce_annual REAL, ebitda_margin REAL, np_margin REAL,
        promoter_pct REAL, fii_pct REAL, mf_pct REAL, pledge_pct REAL,
        promoter_chg_qoq REAL, fii_chg_qoq REAL, mf_chg_qoq REAL, pledge_chg_qoq REAL,
        rev_growth_yoy_q REAL, np_growth_yoy_q REAL,
        days_since_dividend INTEGER, last_dividend_amt REAL
    )""")
    today = date.today().isoformat()
    conn.execute("INSERT INTO stock_ohlcv (symbol, date) VALUES (?, ?)", (REAL_SYMBOL, today))
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (REAL_SYMBOL, today))
    conn.commit()
    tof.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestTrendlyneOverviewLiveDataSource:
    def test_overview_and_profile_endpoints_write_ml_usable_rows(self):
        """Hits both real Trendlyne endpoints for RELIANCE via the fetcher's own _fetch(),
        extracts with the fetcher's own extract_* functions, and writes through its own
        upsert_profile()/backfill_technical_signals() into a throwaway DB."""
        session = requests.Session()
        session.headers.update(tof.HEADERS)

        overview_body = tof._fetch(tof.OVERVIEW_URL.format(tlid=REAL_TLID), session)
        assert overview_body is not None, "overview-second-part endpoint returned nothing for RELIANCE -- may be down/blocked"

        fp_body = tof._fetch(tof.PROFILE_URL.format(tlid=REAL_TLID), session)
        assert fp_body is not None, "fundamental-profile endpoint returned nothing for RELIANCE -- may be down/blocked"

        today = date.today().isoformat()
        conn = _make_test_conn()

        profile = {}
        profile.update(tof.extract_analyst_data(overview_body, REAL_SYMBOL, today, conn))
        profile.update(tof.extract_event_data(overview_body))
        profile.update(tof.extract_profile_data(fp_body))

        assert profile, "extract_* functions produced an entirely empty profile for RELIANCE, a large well-covered stock"
        # A blue-chip like RELIANCE always has annual financials at minimum.
        assert profile.get("np_annual") is not None or profile.get("revenue_annual") is not None, \
            f"neither np_annual nor revenue_annual extracted for RELIANCE: {profile}"

        tof.upsert_profile(REAL_SYMBOL, today, profile, conn)
        row = conn.execute(
            "SELECT symbol, np_annual, revenue_annual, roe, roce FROM trendlyne_stock_profile WHERE symbol = ?",
            (REAL_SYMBOL,),
        ).fetchone()
        assert row is not None, "upsert_profile() wrote no row to trendlyne_stock_profile"
        assert_looks_like_ticker(row["symbol"], context="trendlyne_stock_profile.symbol")
        for col in ("np_annual", "revenue_annual", "roe", "roce"):
            if row[col] is not None:
                assert_numeric_and_finite(row[col], context=f"trendlyne_stock_profile.{col}")

        ts_anchor = tof.logical_write_floor(conn, fallback=today)
        tof.backfill_technical_signals(REAL_SYMBOL, ts_anchor, profile, conn)
        ts_row = conn.execute(
            "SELECT roe_annual, ebitda_margin FROM technical_signals WHERE symbol = ?",
            (REAL_SYMBOL,),
        ).fetchone()
        assert ts_row is not None
        if profile.get("roe") is not None:
            assert_numeric_and_finite(ts_row["roe_annual"], context="technical_signals.roe_annual")
        conn.close()
