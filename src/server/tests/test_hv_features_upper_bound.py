"""Regression test for Finding #67 (2026-07-28 full-stack audit): hv_features.py's OHLCV
read had a lower date bound (`date >= cutoff`) but no upper bound -- the write side
correctly filtered which symbols/dates got updated for a --date backfill, but the HV
values themselves were computed from OHLCV through TODAY regardless of the target date,
leaking future realized volatility (hv_10d/20d/30d/60d, iv_hv_ratio) into a historical
technical_signals row whenever --date targeted the past.
"""
import datetime
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import hv_features as hvf


class _Capture:
    def __init__(self):
        self.calls = []


def _patch_read_df_capture(monkeypatch, capture):
    def fake_read_df(sql, params=()):
        capture.calls.append((sql, params))
        # First call is the OHLCV read; return empty so run() exits early right after,
        # keeping the test focused purely on what bounds were requested.
        return pd.DataFrame(columns=["symbol", "date", "close"])
    monkeypatch.setattr(hvf, "read_df", fake_read_df)


class TestOhlcvReadUpperBound:
    def test_backfill_date_bounds_the_read_to_that_date_not_today(self, monkeypatch):
        capture = _Capture()
        _patch_read_df_capture(monkeypatch, capture)

        hvf.run(only_date="2026-06-01")

        sql, params = capture.calls[0]
        assert "date <= ?" in sql, "OHLCV read must have an upper date bound"
        assert params[-1] == "2026-06-01" or "2026-06-01" in params, \
            f"upper bound must be the backfill target date, got params={params}"
        today = datetime.date.today().isoformat()
        assert today not in params, "must not silently fall back to today's date for a past backfill"

    def test_today_keyword_resolves_to_actual_today(self, monkeypatch):
        capture = _Capture()
        _patch_read_df_capture(monkeypatch, capture)

        hvf.run(only_date="today")

        sql, params = capture.calls[0]
        today = datetime.date.today().isoformat()
        assert today in params

    def test_no_date_arg_defaults_upper_bound_to_today(self, monkeypatch):
        capture = _Capture()
        _patch_read_df_capture(monkeypatch, capture)

        hvf.run(only_date=None)

        sql, params = capture.calls[0]
        assert "date <= ?" in sql
        today = datetime.date.today().isoformat()
        assert today in params

    def test_symbol_filter_still_appends_after_both_bounds(self, monkeypatch):
        capture = _Capture()
        _patch_read_df_capture(monkeypatch, capture)

        hvf.run(only_date="2026-06-01", only_symbol="tcs")

        sql, params = capture.calls[0]
        assert "AND symbol = ?" in sql
        assert params[-1] == "TCS"
        assert "2026-06-01" in params
