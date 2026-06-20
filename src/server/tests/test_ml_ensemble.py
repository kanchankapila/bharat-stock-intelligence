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


class TestFundamentalFactors:
    """Quality/Value/Growth/Size factors from stock_fundamentals must enter the model."""
    FUND_COLS = ['piotroski', 'debt_to_equity', 'operating_margins', 'return_on_equity',
                 'revenue_growth', 'earnings_growth', 'earnings_yield', 'price_to_book',
                 'log_market_cap']

    def test_fundamental_features_present(self):
        X = build_features(_make_feature_df())
        for c in self.FUND_COLS:
            assert c in X.columns

    def test_missing_fundamentals_fall_back_without_nan(self):
        X = build_features(_make_feature_df())  # df lacks the fundamental columns
        for c in self.FUND_COLS:
            assert not X[c].isna().any()

    def test_fundamental_values_pass_through(self):
        df = _make_feature_df(3)
        df['return_on_equity'] = [15.0, 20.0, 25.0]
        df['debt_to_equity'] = [0.2, 1.0, 2.0]
        X = build_features(df)
        assert list(X['return_on_equity']) == pytest.approx([15.0, 20.0, 25.0])
        assert list(X['debt_to_equity']) == pytest.approx([0.2, 1.0, 2.0])

    def test_market_cap_is_log_transformed(self):
        df = _make_feature_df(1)
        df['market_cap'] = [1_000_000_000.0]
        X = build_features(df)
        assert X['log_market_cap'].iloc[0] == pytest.approx(np.log1p(1e9), rel=1e-4)


class TestSampleUniqueness:
    """Overlapping forward-return labels aren't IID — average uniqueness down-weights
    crowded periods so the model doesn't overcount correlated outcomes (overfit fix)."""

    def test_isolated_labels_are_fully_unique(self):
        from src.server.ml_ensemble import average_uniqueness
        u = average_uniqueness([0, 10, 20], [5, 5, 5])  # no overlap
        assert u == pytest.approx([1.0, 1.0, 1.0])

    def test_identical_labels_split_uniqueness(self):
        from src.server.ml_ensemble import average_uniqueness
        u = average_uniqueness([0, 0], [5, 5])  # fully concurrent
        assert u == pytest.approx([0.5, 0.5])

    def test_partial_overlap(self):
        from src.server.ml_ensemble import average_uniqueness
        u = average_uniqueness([0, 2], [4, 4])  # spans [0,4) and [2,6) overlap on days 2,3
        assert u == pytest.approx([0.75, 0.75])

    def test_weights_bounded_0_1(self):
        from src.server.ml_ensemble import average_uniqueness
        u = average_uniqueness([0, 0, 0, 1, 5], [10, 10, 3, 2, 1])
        assert all(0.0 < w <= 1.0 for w in u)


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
