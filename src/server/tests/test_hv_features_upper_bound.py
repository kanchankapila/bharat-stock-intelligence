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
from unittest.mock import MagicMock

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import hv_features as hvf
from as_of import logical_trading_date


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

    def test_today_keyword_resolves_to_the_logical_trading_date(self, monkeypatch):
        """`--date today` is the LOGICAL session, not wall-clock today (2026-10-11 audit).

        This engine runs in the post-close ml-daily-ops chain, which regularly finishes
        after IST midnight. A wall-clock anchor there reads OHLCV through a calendar day
        whose bhavcopy is not written yet, so the series silently ends one session early
        and every HV below is one bar short.
        """
        capture = _Capture()
        _patch_read_df_capture(monkeypatch, capture)

        hvf.run(only_date="today")

        sql, params = capture.calls[0]
        assert logical_trading_date() in params

    def test_no_date_arg_bounds_the_read_to_the_logical_trading_date(self, monkeypatch):
        capture = _Capture()
        _patch_read_df_capture(monkeypatch, capture)

        hvf.run(only_date=None)

        sql, params = capture.calls[0]
        assert "date <= ?" in sql
        assert logical_trading_date() in params

    def test_symbol_filter_still_appends_after_both_bounds(self, monkeypatch):
        capture = _Capture()
        _patch_read_df_capture(monkeypatch, capture)

        hvf.run(only_date="2026-06-01", only_symbol="tcs")

        sql, params = capture.calls[0]
        assert "AND symbol = ?" in sql
        assert params[-1] == "TCS"
        assert "2026-06-01" in params


class TestWriteAnchorMatchesReadAnchor:
    """The write side must target the SAME session the read was bounded by.

    Before 2026-10-11 the default run updated each symbol's MAX(date) row whatever date
    that was: a symbol whose feed had stopped weeks ago got today's HV written onto an old
    row, contaminating a historical feature with a value computed through today.
    """

    OHLCV = pd.DataFrame({
        "symbol": ["TCS", "TCS", "TCS"],
        "date": ["2026-08-29", "2026-08-30", "2026-08-31"],
        "close": [100.0, 101.0, 102.0],
    })

    @staticmethod
    def _patch(monkeypatch, rows, write_mock):
        def fake_read_df(sql, params=()):
            if "FROM stock_ohlcv" in sql:
                return TestWriteAnchorMatchesReadAnchor.OHLCV.copy()
            if "FROM technical_signals" in sql:
                if "MAX(date)" in sql and "GROUP BY" not in sql:
                    return pd.DataFrame({"symbol": ["TCS"], "iv_rank": [None]})
                return pd.DataFrame({"symbol": [r[0] for r in rows],
                                     "max_date": [r[1] for r in rows]})
            return pd.DataFrame(columns=["symbol", "date", "close"])
        monkeypatch.setattr(hvf, "read_df", fake_read_df)
        monkeypatch.setattr(hvf, "connect", MagicMock())
        monkeypatch.setattr(hvf, "ensure_schema", MagicMock())
        monkeypatch.setattr(hvf, "executemany", write_mock)

    def test_stale_symbols_are_skipped_not_written(self, monkeypatch):
        """A symbol whose latest row is NOT the target session must not be written,
        even though its OHLCV exists and HV computed fine."""
        write = MagicMock(return_value=1)
        self._patch(monkeypatch, [("TCS", "2026-06-01")], write)

        updated = hvf.run(only_date="2026-08-31")

        assert updated == 0
        write.assert_not_called()

    def test_symbols_on_the_target_session_are_written(self, monkeypatch):
        write = MagicMock(return_value=1)
        self._patch(monkeypatch, [("TCS", "2026-08-31")], write)

        updated = hvf.run(only_date="2026-08-31")

        assert updated == 1
        sql, params = write.call_args.args
        assert "WHERE symbol = ?" in sql
        assert params[-1][-2] == "TCS"      # trailing (symbol, symbol) anchor pair
