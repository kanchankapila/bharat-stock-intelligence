"""
Tests for breakout_classifier — pure forward-label construction (no DB, no model).
The label is the novel, leakage-prone part; the training harness reuses ml_ensemble.
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from breakout_classifier import forward_max_return, build_breakout_labels


def _wide(prices_by_symbol, n):
    dates = pd.date_range("2026-01-01", periods=n, freq="B").strftime("%Y-%m-%d")
    return pd.DataFrame(prices_by_symbol, index=dates)


class TestForwardMaxReturn:
    def test_flat_series_is_zero(self):
        close = _wide({"A": [100.0] * 20}, 20)
        ret = forward_max_return(close, horizon=5)
        # early rows have a full forward window of 100 → 0.0 return
        assert ret["A"].iloc[0] == 0.0

    def test_captures_a_future_spike(self):
        px = [100.0] * 20
        px[5] = 110.0  # +10% spike on day 5
        close = _wide({"A": px}, 20)
        ret = forward_max_return(close, horizon=5)
        # day 1 (index 1) looks forward to days 2..6, which include the 110 spike → +10%
        assert ret["A"].iloc[1] == pytest.approx(0.10, abs=1e-9)

    def test_tail_rows_without_full_window_are_nan(self):
        close = _wide({"A": [100.0] * 20}, 20)
        ret = forward_max_return(close, horizon=5)
        assert np.isnan(ret["A"].iloc[-1])   # last row can't look 5 forward
        assert np.isnan(ret["A"].iloc[-3])


class TestBuildBreakoutLabels:
    def test_labels_a_breakout(self):
        px = [100.0] * 30
        px[10] = 108.0  # +8% within horizon of earlier days
        close = _wide({"A": px}, 30)
        labels = build_breakout_labels(close, horizon=8, ret_threshold=0.06)
        row = labels[(labels["symbol"] == "A") & (labels["date"] == close.index[3])]
        assert int(row["flew"].iloc[0]) == 1

    def test_non_breakout_is_zero(self):
        close = _wide({"A": [100.0, 101.0, 100.5] * 10}, 30)
        labels = build_breakout_labels(close, horizon=8, ret_threshold=0.06)
        assert set(labels["flew"].unique()) <= {0}

    def test_penny_stocks_dropped(self):
        px = [5.0] * 30
        px[10] = 6.0  # +20% but penny — should be excluded
        close = _wide({"CHEAP": px}, 30)
        labels = build_breakout_labels(close, horizon=8, ret_threshold=0.06, min_price=20.0)
        assert labels.empty or (labels["symbol"] != "CHEAP").all()

    def test_output_shape_and_types(self):
        close = _wide({"A": [50.0] * 30, "B": [60.0] * 30}, 30)
        labels = build_breakout_labels(close, horizon=5)
        assert list(labels.columns) == ["symbol", "date", "flew"]
        assert labels["flew"].isin([0, 1]).all()

    def test_no_labels_when_all_tail(self):
        # only 4 rows, horizon 5 → no row has a full forward window
        close = _wide({"A": [100.0] * 4}, 4)
        labels = build_breakout_labels(close, horizon=5)
        assert labels.empty
