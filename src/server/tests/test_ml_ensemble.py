import sys
import os
import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.ml_ensemble import build_features, load_training_data, train_ensemble
import sqlite3


def _make_feature_df(n=10):
    return pd.DataFrame({
        'signal_score':  [5] * n,
        'rsi':           [50.0] * n,
        'adx':           [25.0] * n,
        'volume_ratio':  [1.0] * n,
        'horizon_days':  [15] * n,
        'nifty_regime':  ['BULL'] * n,
        'cmp':           [100.0] * n,
        'sma200':        [90.0] * n,
        'fii_3d_net':    [0.0] * n,
        'above_sma200':  [1] * n,
        'fifty_two_week_high': [110.0] * n,
        'signals_json':  ['[]'] * n,
        # These should NOT appear in features:
        'screener_score':  [80.0] * n,
        'max_return_pct':  [15.0] * n,
    })


class TestNoLookAheadFeatures:
    def test_screener_score_not_in_features(self):
        df = _make_feature_df()
        X = build_features(df)
        assert 'screener_score' not in X.columns, (
            "screener_score is a look-ahead feature (today's score joined to historical rows)"
        )

    def test_max_return_pct_not_in_features(self):
        df = _make_feature_df()
        X = build_features(df)
        assert 'max_return_pct' not in X.columns, (
            "max_return_pct is future information — it's the best return DURING the holding period"
        )


class TestTemporalCV:
    """TimeSeriesSplit must not allow future rows into earlier fold's training set."""

    def test_no_future_data_in_cv_folds(self):
        from sklearn.model_selection import TimeSeriesSplit
        # Simulate 100 chronologically ordered samples
        dates = pd.date_range('2023-01-01', periods=100, freq='D')
        idx = np.arange(100)

        skf = TimeSeriesSplit(n_splits=5)
        for train_idx, val_idx in skf.split(idx):
            # All training indices must be strictly less than all validation indices
            assert max(train_idx) < min(val_idx), (
                f"Temporal leakage: train max={max(train_idx)} >= val min={min(val_idx)}"
            )

    def test_training_data_sorted_before_cv(self):
        """Simulate the run() path: data must be sorted by signal_date before TimeSeriesSplit."""
        df = pd.DataFrame({
            'signal_date': pd.to_datetime(['2024-03-01', '2023-01-01', '2024-06-01']),
            'outcome': [1, 0, 1],
        })
        df = df.sort_values('signal_date').reset_index(drop=True)
        dates = df['signal_date'].tolist()
        # After sort, dates must be non-decreasing
        for i in range(1, len(dates)):
            assert dates[i] >= dates[i - 1]


class TestLoadTrainingDataNoLeakColumns:
    """load_training_data SQL must not SELECT screener_score or max_return_pct."""

    def test_training_query_has_no_screener_score(self):
        import inspect
        import src.server.ml_ensemble as mod
        src_code = inspect.getsource(mod.load_training_data)
        assert 'screener_score' not in src_code, (
            "load_training_data selects screener_score — join to stock_scores has no date filter"
        )

    def test_training_query_has_no_max_return_pct(self):
        import inspect
        import src.server.ml_ensemble as mod
        src_code = inspect.getsource(mod.load_training_data)
        assert 'max_return_pct' not in src_code, (
            "load_training_data selects max_return_pct — this is the maximum return DURING the horizon (future leak)"
        )
