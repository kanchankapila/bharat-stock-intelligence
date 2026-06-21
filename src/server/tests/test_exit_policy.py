"""
Tests for exit_policy — MFE/MAE regressors and level translation.
suggest_levels is pure; train_from_df / predict_levels run on synthetic data (no DB).
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from exit_policy import suggest_levels, train_from_df, predict_levels


class TestSuggestLevels:
    def test_capture_and_buffer_math(self):
        target, stop = suggest_levels(100.0, pred_mfe_pct=10.0, pred_mae_pct=-5.0,
                                      mfe_capture=0.6, mae_buffer=1.15)
        assert target == pytest.approx(106.0)     # 100 × (1 + 10×0.6/100)
        assert stop == pytest.approx(94.25)        # 100 × (1 + (-5×1.15)/100)

    def test_long_ordering_target_above_entry_above_stop(self):
        target, stop = suggest_levels(250.0, pred_mfe_pct=8.0, pred_mae_pct=-4.0)
        assert target > 250.0 > stop


def _synthetic(n=80, seed=0):
    rng = np.random.default_rng(seed)
    score = rng.integers(1, 11, n).astype(float)
    return pd.DataFrame({
        "symbol": [f"S{i%10}" for i in range(n)],
        "signal_date": pd.bdate_range("2024-01-01", periods=n).strftime("%Y-%m-%d"),
        "signal_score": score,
        "signals_json": ["[]"] * n,
        # MFE grows with score, MAE shrinks (more negative) with weaker scores — learnable.
        "mfe_pct": 5 + 0.8 * score + rng.normal(0, 0.5, n),
        "mae_pct": -(6 - 0.4 * score) + rng.normal(0, 0.3, n),
    })


class TestTrainAndPredict:
    def test_insufficient_data_returns_none(self):
        assert train_from_df(_synthetic(10), min_samples=50) is None

    def test_trains_and_persists_both_heads(self):
        payload = train_from_df(_synthetic(80), min_samples=20)
        assert payload is not None
        assert "mfe_model" in payload and "mae_model" in payload
        assert payload["feature_names"]
        assert payload["n_samples"] == 80
        assert np.isfinite(payload["metrics"]["mfe_holdout_mae"])

    def test_predict_levels_returns_sane_long_bracket(self):
        payload = train_from_df(_synthetic(80), min_samples=20)
        row = _synthetic(1, seed=3).iloc[[0]]
        target, stop = predict_levels(row, entry=100.0, model=payload)
        assert target > 100.0 > stop          # predicted MFE>0, MAE<0 → bracket straddles entry
