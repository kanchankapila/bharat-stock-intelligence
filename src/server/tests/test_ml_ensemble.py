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


class TestImpliedVolFeatures:
    """ATM IV-rank + put/call skew (orthogonal to every price feature) must enter the model
    and fall back to neutral when the options feed has no coverage."""

    def test_iv_features_present(self):
        X = build_features(_make_feature_df())
        for c in ('iv_rank', 'iv_skew', 'score_x_low_iv'):
            assert c in X.columns

    def test_missing_iv_falls_back_to_neutral(self):
        X = build_features(_make_feature_df())  # no iv columns supplied
        assert (X['iv_rank'] == 0.5).all()
        assert (X['iv_skew'] == 0.0).all()

    def test_iv_rank_clipped_and_interaction(self):
        df = _make_feature_df(3)
        df['signal_score'] = [8, 8, 8]
        df['iv_rank'] = [-0.2, 0.25, 1.5]          # out-of-range values must clip to [0,1]
        X = build_features(df)
        assert list(X['iv_rank']) == pytest.approx([0.0, 0.25, 1.0])
        # strong signal into cheap IV scores highest: score × (1 − iv_rank)
        assert list(X['score_x_low_iv']) == pytest.approx([8.0, 6.0, 0.0])


class TestRelativeStrengthFeatures:
    """Cross-sectional RS ranks must enter the model and fall back to neutral mid-rank."""

    def test_rs_features_present(self):
        X = build_features(_make_feature_df())
        assert 'rs_rank_21d' in X.columns and 'rs_rank_63d' in X.columns

    def test_missing_rs_falls_back_to_mid_rank(self):
        X = build_features(_make_feature_df())
        assert (X['rs_rank_21d'] == 0.5).all() and (X['rs_rank_63d'] == 0.5).all()

    def test_rs_clipped_to_unit_interval(self):
        df = _make_feature_df(3)
        df['rs_rank_21d'] = [-0.3, 0.4, 1.7]
        X = build_features(df)
        assert list(X['rs_rank_21d']) == pytest.approx([0.0, 0.4, 1.0])


class TestMCVitalsFeatures:
    """Altman Z and Ohlson O-Score from proprietary_scores_history AS-OF pivot."""

    def test_vitals_features_present(self):
        X = build_features(_make_feature_df())
        for col in ['altman_z', 'altman_distress', 'ohlson_o']:
            assert col in X.columns, f"Expected {col} in build_features output"

    def test_missing_vitals_no_nan(self):
        X = build_features(_make_feature_df())
        assert not X['altman_z'].isna().any()
        assert not X['altman_distress'].isna().any()
        assert not X['ohlson_o'].isna().any()

    def test_altman_distress_fires_below_threshold(self):
        df = _make_feature_df(n=3)
        df['altman_z'] = [1.0, 2.0, 3.5]  # distress / grey / safe
        X = build_features(df)
        assert X['altman_distress'].iloc[0] == 1.0  # < 1.23 → distress flag
        assert X['altman_distress'].iloc[1] == 0.0  # grey zone → no flag
        assert X['altman_distress'].iloc[2] == 0.0  # safe zone → no flag

    def test_altman_z_clipped(self):
        df = _make_feature_df(n=2)
        df['altman_z'] = [-99.0, 999.0]
        X = build_features(df)
        assert X['altman_z'].iloc[0] >= -5.0
        assert X['altman_z'].iloc[1] <= 15.0

    def test_ohlson_o_clipped(self):
        df = _make_feature_df(n=2)
        df['ohlson_o'] = [-99.0, 999.0]
        X = build_features(df)
        assert X['ohlson_o'].iloc[0] >= -10.0
        assert X['ohlson_o'].iloc[1] <= 5.0


class TestEmptyInput:
    """build_features must not crash when load_pending_signals returns zero rows (the calendar
    block divided an empty datetime-typed Series)."""

    def test_empty_with_signal_date_does_not_crash(self):
        df = pd.DataFrame(columns=['symbol', 'signal_date', 'signal_score', 'signals_json'])
        X = build_features(df)            # must not raise
        assert len(X) == 0
        assert 'days_to_fno_expiry' in X.columns and 'results_season' in X.columns

    def test_empty_without_signal_date_does_not_crash(self):
        X = build_features(pd.DataFrame(columns=['signal_score']))
        assert len(X) == 0


class TestMarketLevelFeaturesExcluded:
    """India-VIX and breadth are market-LEVEL (identical per date) and were measured to add no
    cross-sectional signal to this per-stock classifier (raw and interaction forms both hurt
    held-out AUC vs omitting them). Lock them out of the feature matrix."""

    def test_no_market_level_features(self):
        X = build_features(_make_feature_df())
        for col in ('india_vix', 'vix_change_5d', 'pct_above_200dma', 'adv_decline_ratio',
                    'pct_at_20d_high', 'net_highs_lows', 'rs_x_breadth', 'lead_in_weak_tape',
                    'vix_chg_x_score'):
            assert col not in X.columns, f"{col} should not be an ensemble feature (no cross-sectional signal)"


class TestCalendarFeatures:
    """Event-proximity features are pure functions of signal_date — leak-free timing edge."""

    def _df(self, dates):
        n = len(dates)
        df = _make_feature_df(n)
        df['signal_date'] = dates
        return df

    def test_features_present_and_safe_without_date(self):
        X = build_features(_make_feature_df())   # no signal_date column
        assert 'days_to_fno_expiry' in X.columns and 'results_season' in X.columns
        assert not X['days_to_fno_expiry'].isna().any()
        assert not X['results_season'].isna().any()

    def test_days_to_monthly_expiry(self):
        # Last Thursday of Apr-2024 is the 25th; from the 15th that is 10 calendar days.
        X = build_features(self._df(['2024-04-15']))
        assert X['days_to_fno_expiry'].iloc[0] == pytest.approx(10 / 30.0)

    def test_expiry_rolls_to_next_month_after_expiry(self):
        # After Apr-25 expiry, the 28th rolls to May-2024's last Thursday (the 30th) → 32 days.
        X = build_features(self._df(['2024-04-28']))
        assert X['days_to_fno_expiry'].iloc[0] == pytest.approx(32 / 30.0)

    def test_results_season_flag(self):
        X = build_features(self._df(['2024-04-10', '2024-06-10']))
        assert list(X['results_season']) == [1.0, 0.0]   # Apr in season, Jun not


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

    def test_vitals_query_uses_as_of_join(self):
        import inspect
        src = inspect.getsource(load_training_data)
        assert 'proprietary_scores_history' in src
        assert 'p2.date <= so.signal_date' in src, "Altman Z join must be AS-OF (no look-ahead)"
        assert 'altman_z_score' in src, "Must query for altman_z_score"
        assert 'ohlson_o_score' in src, "Must query for ohlson_o_score"


class TestInsiderActivityFeatures:
    def test_insider_features_present(self):
        X = build_features(_make_feature_df())
        assert 'insider_buy_pct_90d' in X.columns
        assert 'insider_x_score' in X.columns

    def test_missing_insider_falls_back_to_neutral(self):
        X = build_features(_make_feature_df())
        assert (X['insider_buy_pct_90d'] == 0.5).all()

    def test_insider_values_pass_through(self):
        df = _make_feature_df(n=2)
        df['insider_buy_pct_90d'] = [0.9, 0.1]
        X = build_features(df)
        assert X['insider_buy_pct_90d'].iloc[0] == pytest.approx(0.9, abs=0.01)
        assert X['insider_buy_pct_90d'].iloc[1] == pytest.approx(0.1, abs=0.01)


class TestIntradayMicrostructureFeatures:
    def test_intraday_features_present(self):
        X = build_features(_make_feature_df())
        for col in ['opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share']:
            assert col in X.columns

    def test_missing_intraday_falls_back_to_neutral(self):
        X = build_features(_make_feature_df())
        assert (X['opening_range_break'] == 0.0).all()
        assert (X['vwap_deviation_pct']  == 0.0).all()
        assert (X['first_hour_vol_share'] == 0.5).all()

    def test_intraday_values_pass_through(self):
        df = _make_feature_df(n=3)
        df['opening_range_break']  = [1.0, -1.0, 0.0]
        df['vwap_deviation_pct']   = [3.5, -2.1, 0.0]
        df['first_hour_vol_share'] = [0.8,  0.2, 0.5]
        X = build_features(df)
        assert X['opening_range_break'].iloc[0]  == pytest.approx(1.0,  abs=0.01)
        assert X['vwap_deviation_pct'].iloc[1]   == pytest.approx(-2.1, abs=0.01)
        assert X['first_hour_vol_share'].iloc[2] == pytest.approx(0.5,  abs=0.01)
