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
from breakout_classifier import (
    forward_max_return, build_breakout_labels, compute_delivery_features,
    DELIVERY_FEATURE_COLS, FEATURE_COLS, SECTOR_FEATURE_COLS,
)


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


class TestComputeDeliveryFeatures:
    """compute_delivery_features -- the pure OHLCV-shaped transform used by
    --delivery-ablation. Not wired into production FEATURE_COLS (measured 2026-09-02: no
    lift on the restricted delivery-covered window) -- these tests just guard the plumbing
    stays correct for the next re-test, and that SECTOR/DELIVERY cols never leak into the
    default trained feature set."""

    def _delivery_frame(self, pct, qty, n):
        dates = pd.date_range("2026-01-01", periods=n, freq="B").strftime("%Y-%m-%d")
        rows = []
        for i, d in enumerate(dates):
            rows.append({"symbol": "A", "date": d, "delivery_pct": pct[i], "delivery_qty": qty[i]})
        return pd.DataFrame(rows)

    def test_output_shape_and_columns(self):
        n = 25
        delivery = self._delivery_frame([50.0] * n, [1000] * n, n)
        out = compute_delivery_features(delivery)
        assert list(out.columns) == ["date", "symbol"] + DELIVERY_FEATURE_COLS
        assert len(out) == n

    def test_delivery_pct_chg_5d_is_the_5_session_delta(self):
        n = 10
        pct = [50.0] * 5 + [65.0] * 5  # jumps +15 exactly at day 5
        delivery = self._delivery_frame(pct, [1000] * n, n)
        out = compute_delivery_features(delivery).sort_values("date").reset_index(drop=True)
        # day index 5 (6th row) compares 65.0 vs day-0's 50.0 -> +15
        assert out["delivery_pct_chg_5d"].iloc[5] == pytest.approx(15.0)
        # first 5 rows have no day-minus-5 to compare against -> NaN
        assert out["delivery_pct_chg_5d"].iloc[:5].isna().all()

    def test_delivery_qty_surge_flags_a_volume_spike(self):
        n = 25
        qty = [1000] * 20 + [5000] * 5  # 5x spike in the last 5 sessions
        delivery = self._delivery_frame([50.0] * n, qty, n)
        out = compute_delivery_features(delivery).sort_values("date").reset_index(drop=True)
        # rolling(20).mean() at the last row blends 15 pre-spike + 5 spike days -> 2000 avg;
        # 5000/2000 = 2.5x -- well above the flat 1.0 baseline a non-spiking series would show.
        assert out["delivery_qty_surge"].iloc[-1] == pytest.approx(2.5)

    def test_delivery_and_sector_cols_are_not_in_the_default_feature_set(self):
        # Guards against silently re-wiring an ungraded/no-edge feature back into production
        # -- both were measured 2026-09-02 and found to add no lift (see breakout_classifier
        # module docstring). If either is ever re-added, it must be a deliberate FEATURE_COLS
        # edit backed by a fresh measurement, not an accidental import-order side effect.
        assert not set(DELIVERY_FEATURE_COLS) & set(FEATURE_COLS)
        assert not set(SECTOR_FEATURE_COLS) & set(FEATURE_COLS)
