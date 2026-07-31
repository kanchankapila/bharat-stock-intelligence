"""Live-datasource test for mc_pricefeed_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). One of the ~130 previously-untested fetchers flagged in the
2026-07-30 fifth full-stack-audit pass -- and one of the highest-priority ones, since it
feeds ~27 technical_signals columns consumed by ml_ensemble.py.
"""
import os
import sqlite3
import sys
from datetime import date

import pytest
from curl_cffi import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mc_pricefeed_fetcher as mpf
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable

# RELIANCE's MoneyControl scid (see src/data/stocklist.ts's StockMapping) — one of the
# 180 liquid stocks with a stable, well-known provider mapping.
REAL_SYMBOL = "RELIANCE"
REAL_MCSYMBOL = "RI"


def _make_test_conn():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT)")
    conn.execute(
        "INSERT INTO technical_signals (symbol, date) VALUES (?, ?)",
        (REAL_SYMBOL, date.today().isoformat()),
    )
    conn.commit()
    mpf.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestMcPricefeedLiveDataSource:
    def test_real_fetch_returns_ml_usable_features(self):
        """Step 1-3: hit the real MC pricefeed endpoint, parse with the fetcher's own
        extract_features(), assert non-empty and key numeric fields are usable."""
        session = requests.Session()
        data = mpf._fetch(REAL_MCSYMBOL, session)
        assert_non_empty_response(data, f"_fetch({REAL_MCSYMBOL})")

        f = mpf.extract_features(data)
        assert isinstance(f["price"], (int, float)) and f["price"] > 0, \
            f"price not a usable positive number: {f['price']!r}"
        # At least the core valuation/price fields must be present for a large, well-covered
        # stock like RELIANCE — not asserting on every one of the ~40 fields (some are
        # legitimately sparse per-stock, e.g. fno_lot_size for a non-F&O-eligible name).
        for key in ("pe", "high_52w", "low_52w", "ma_200"):
            assert f.get(key) is not None, f"expected {key!r} to be populated for {REAL_SYMBOL}"

    def test_real_fetch_stores_ml_usable_rows(self):
        """Step 4-5: write through the fetcher's own upsert_row()/backfill_technical_signals()
        into a throwaway in-memory SQLite DB, then read the rows back and validate they're
        ML-usable."""
        session = requests.Session()
        data = mpf._fetch(REAL_MCSYMBOL, session)
        assert_non_empty_response(data, f"_fetch({REAL_MCSYMBOL})")
        f = mpf.extract_features(data)

        conn = _make_test_conn()
        today = date.today().isoformat()
        mpf.upsert_row(REAL_SYMBOL, today, f, conn)
        mpf.backfill_technical_signals(REAL_SYMBOL, today, f, conn)
        mpf.append_pe_pb_history(REAL_SYMBOL, today, f.get("pe"), f.get("pb"), conn)

        pf_row = conn.execute(
            "SELECT * FROM mc_pricefeed_daily WHERE symbol = ?", (REAL_SYMBOL,)
        ).fetchone()
        assert pf_row is not None, "no row landed in mc_pricefeed_daily after upsert_row()"
        assert_stored_row_ml_usable(dict(pf_row), numeric_cols=["price"], ticker_cols=["symbol"],
                                     context="mc_pricefeed_daily")

        ts_row = conn.execute(
            "SELECT * FROM technical_signals WHERE symbol = ?", (REAL_SYMBOL,)
        ).fetchone()
        assert ts_row is not None
        ts_row = dict(ts_row)
        assert ts_row["mc_ind_pe"] is not None or ts_row["mc_consensus_pe"] is not None, \
            "backfill_technical_signals() wrote no fundamentals fields at all onto the matching row"
