"""Regression tests for Finding #6 (2026-07-28 full-stack audit): mc_ohlcv_backfill.py
writes SPLIT-ONLY adjusted stock_ohlcv rows; backfill_ohlcv.py's yfinance leg (auto_adjust=
True) writes SPLIT+DIVIDEND adjusted rows for the same table -- live-verified (ITC.NS,
2026-07-30) that yfinance's dividend component alone shifts a 90-day-old bar by ~2.65%, a
real discontinuity wherever the two writers' date ranges meet. Every row-producing path in
both files now tags its rows with which basis wrote them (adjustment_basis column) so
downstream consumers can detect/correct a straddling return window -- this test only proves
the tagging itself is correct and consistent per code path; it does not (and does not
attempt to) validate the underlying price-adjustment math.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402
import backfill_ohlcv as bo


class TestExtractRecordsTagging:
    def test_yfinance_records_tagged_split_dividend(self):
        df = pd.DataFrame({
            "Open": [100.0], "High": [105.0], "Low": [99.0], "Close": [102.0], "Volume": [1000],
        }, index=pd.to_datetime(["2026-07-29"]))
        df.index.name = "Date"
        records = bo._extract_records("TCS", df)
        assert len(records) == 1
        assert records[0][-1] == "split_dividend"
        assert len(records[0]) == 8  # symbol, date, o, h, l, c, v, adjustment_basis

    def test_empty_dataframe_returns_no_records(self):
        assert bo._extract_records("TCS", pd.DataFrame()) == []


class TestMcOhlcvBackfillTagging:
    def test_ensure_adjustment_basis_column_is_idempotent(self):
        import sqlite3
        con = pg_memory_conn()
        con.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER)")
        con.commit()

        import mc_ohlcv_backfill as mob
        # First call adds the column
        mob.ensure_adjustment_basis_column(con)
        cols = [r[1] for r in con.execute("PRAGMA table_info(stock_ohlcv)").fetchall()]
        assert "adjustment_basis" in cols
        # Second call must not raise (already exists)
        mob.ensure_adjustment_basis_column(con)
