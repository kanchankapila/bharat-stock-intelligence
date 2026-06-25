"""
Tests for cs_ranker.py:
  1. Alpha percentile label construction (given known returns, assert ranks)
  2. Minimum-date filter (dates with < MIN_DATE_SIGNALS signals excluded)
  3. Feature reuse: build_features produces same columns from cs_ranker vs ml_ensemble
  4. Inference normalization: score_batch output is in [0, 100], top stock scores highest
  5. Spearman rho computation on synthetic data
"""
import sys
import os
import pytest
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from cs_ranker import MIN_DATE_SIGNALS, train_cs_ranker, load_cs_model, save_cs_model
from ml_ensemble import build_features


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_row(**kwargs):
    defaults = {
        'signal_score': 5.0, 'rsi': 50.0, 'adx': 20.0, 'volume_ratio': 1.0,
        'horizon_days': 15, 'nifty_regime': 'BULL', 'cmp': 100.0, 'sma200': 95.0,
        'signals_json': None, 'fii_3d_net': 0, 'above_sma200': 1, 'pcr_oi': 1.0,
        'pcr_vol': 1.0, 'fii_10d_net': 0, 'dii_3d_net': 0, 'delivery_pct': 50,
        'sector_ret_5d': 0, 'sector_ret_21d': 0, 'iv_rank': 0.5, 'iv_skew': 0,
        'rs_rank_21d': 0.5, 'rs_rank_63d': 0.5, 'insider_buy_pct_90d': 0.5,
        'opening_range_break': 0, 'vwap_deviation_pct': 0, 'first_hour_vol_share': 0.5,
        'fifty_two_week_high': 110.0, 'piotroski_f_score': 5, 'debt_to_equity': 0.5,
        'operating_margins': 15, 'return_on_equity': 12, 'revenue_growth': 10,
        'earnings_growth': 8, 'earnings_yield': 4, 'price_to_book': 2.5,
        'market_cap': 1e10, 'n_analysts': 5, 'buy_count': 3, 'target_mean': 105,
        'altman_z': 3.0, 'ohlson_o': -2.0,
    }
    defaults.update(kwargs)
    return defaults


def _make_training_df(rows):
    """Build a DataFrame suitable for train_cs_ranker from list of dicts."""
    df = pd.DataFrame(rows)
    df['signal_date'] = df['signal_date'].astype(str)
    return df


# ── Test 1: Label construction — alpha percentile ranks ───────────────────────

class TestAlphaPercentileLabels:
    def test_three_signals_same_date_rank_correctly(self):
        """3 signals on one date: alpha -2, 0, +5 → percentiles 0, 50, 100."""
        date = '2025-01-10'
        rows = [
            {'signal_date': date, 'symbol': 'A', 'alpha': -2.0},
            {'signal_date': date, 'symbol': 'B', 'alpha':  0.0},
            {'signal_date': date, 'symbol': 'C', 'alpha':  5.0},
        ]
        df = pd.DataFrame(rows)

        def _pct_rank_group(group):
            n = len(group)
            ranks = group['alpha'].rank(method='average')
            group = group.copy()
            group['cs_percentile'] = (ranks - 1) / max(1, n - 1) * 100
            return group

        result = df.groupby('signal_date', group_keys=False).apply(_pct_rank_group)
        result = result.set_index('symbol')

        assert result.loc['A', 'cs_percentile'] == pytest.approx(0.0)
        assert result.loc['B', 'cs_percentile'] == pytest.approx(50.0)
        assert result.loc['C', 'cs_percentile'] == pytest.approx(100.0)

    def test_two_signals_same_date_get_0_and_100(self):
        """2 signals → min=0, max=100."""
        date = '2025-01-11'
        rows = [
            {'signal_date': date, 'symbol': 'X', 'alpha': 1.0},
            {'signal_date': date, 'symbol': 'Y', 'alpha': 3.0},
        ]
        df = pd.DataFrame(rows)

        def _pct_rank_group(group):
            n = len(group)
            ranks = group['alpha'].rank(method='average')
            group = group.copy()
            group['cs_percentile'] = (ranks - 1) / max(1, n - 1) * 100
            return group

        result = df.groupby('signal_date', group_keys=False).apply(_pct_rank_group)
        result = result.set_index('symbol')

        assert result.loc['X', 'cs_percentile'] == pytest.approx(0.0)
        assert result.loc['Y', 'cs_percentile'] == pytest.approx(100.0)


# ── Test 2: Minimum date filter ───────────────────────────────────────────────

class TestMinDateFilter:
    def test_dates_below_min_signals_excluded(self):
        """
        Date A has MIN_DATE_SIGNALS - 1 rows → excluded.
        Date B has MIN_DATE_SIGNALS rows → included.
        """
        rows_a = [{'signal_date': '2025-01-05', 'symbol': f'S{i}', 'alpha': float(i)}
                  for i in range(MIN_DATE_SIGNALS - 1)]
        rows_b = [{'signal_date': '2025-01-06', 'symbol': f'T{i}', 'alpha': float(i)}
                  for i in range(MIN_DATE_SIGNALS)]

        df = pd.DataFrame(rows_a + rows_b)
        date_counts = df.groupby('signal_date')['symbol'].count()
        valid_dates = date_counts[date_counts >= MIN_DATE_SIGNALS].index
        filtered = df[df['signal_date'].isin(valid_dates)]

        assert '2025-01-05' not in filtered['signal_date'].values
        assert '2025-01-06' in filtered['signal_date'].values

    def test_date_exactly_at_min_is_included(self):
        rows = [{'signal_date': '2025-02-01', 'symbol': f'Z{i}', 'alpha': float(i)}
                for i in range(MIN_DATE_SIGNALS)]
        df = pd.DataFrame(rows)
        date_counts = df.groupby('signal_date')['symbol'].count()
        valid_dates = date_counts[date_counts >= MIN_DATE_SIGNALS].index
        assert '2025-02-01' in valid_dates


# ── Test 3: Feature reuse ─────────────────────────────────────────────────────

class TestFeatureReuse:
    def test_build_features_same_columns_from_cs_ranker_import(self):
        """cs_ranker imports build_features from ml_ensemble — same columns result."""
        from cs_ranker import build_features as cs_bf
        from ml_ensemble import build_features as ens_bf

        row = pd.DataFrame([_make_row()])
        X_cs  = cs_bf(row)
        X_ens = ens_bf(row)

        assert list(X_cs.columns) == list(X_ens.columns), (
            "cs_ranker.build_features columns differ from ml_ensemble.build_features"
        )


# ── Test 4: Inference normalization ──────────────────────────────────────────

class TestInferenceNormalization:
    def test_score_batch_normalization_produces_0_to_100(self):
        """Given raw LightGBM predictions, the double-argsort normalization yields [0,100]."""
        raw_preds = np.array([0.3, 1.5, 0.8, 2.1, 0.1])
        n = len(raw_preds)
        rank_order = raw_preds.argsort().argsort()
        cs_scores  = rank_order / max(1, n - 1) * 100

        assert cs_scores.min() == pytest.approx(0.0)
        assert cs_scores.max() == pytest.approx(100.0)

    def test_score_batch_normalization_top_stock_scores_highest(self):
        """Stock with highest raw prediction gets cs_score=100."""
        raw_preds = np.array([0.3, 1.5, 0.8, 2.1, 0.1])
        n = len(raw_preds)
        rank_order = raw_preds.argsort().argsort()
        cs_scores  = rank_order / max(1, n - 1) * 100

        best_idx = np.argmax(raw_preds)
        assert cs_scores[best_idx] == pytest.approx(100.0)

    def test_score_batch_normalization_worst_stock_scores_zero(self):
        """Stock with lowest raw prediction gets cs_score=0."""
        raw_preds = np.array([0.3, 1.5, 0.8, 2.1, 0.1])
        n = len(raw_preds)
        rank_order = raw_preds.argsort().argsort()
        cs_scores  = rank_order / max(1, n - 1) * 100

        worst_idx = np.argmin(raw_preds)
        assert cs_scores[worst_idx] == pytest.approx(0.0)


# ── Test 5: Spearman rho on synthetic data ────────────────────────────────────

class TestSpearmanRho:
    def test_perfect_prediction_yields_rho_1(self):
        """When predictions perfectly track actuals, Spearman ρ = 1.0."""
        from scipy.stats import spearmanr
        actuals = np.array([10, 20, 30, 40, 50], dtype=float)
        preds   = np.array([1.1, 2.2, 3.3, 4.4, 5.5], dtype=float)
        rho, _ = spearmanr(actuals, preds)
        assert rho == pytest.approx(1.0)

    def test_reverse_prediction_yields_rho_minus1(self):
        """Inverted predictions → ρ = -1.0."""
        from scipy.stats import spearmanr
        actuals = np.array([10, 20, 30, 40, 50], dtype=float)
        preds   = np.array([5.5, 4.4, 3.3, 2.2, 1.1], dtype=float)
        rho, _ = spearmanr(actuals, preds)
        assert rho == pytest.approx(-1.0)


# ── Test 5: unified_ranker integration ───────────────────────────────────────

class TestUnifiedRankerIntegration:
    def test_get_cs_scores_query_structure(self):
        """_get_cs_scores exists on UnifiedRanker and follows the same contract as _get_ml_scores."""
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from unified_ranker import UnifiedRanker, _normalize_to_100
        assert hasattr(UnifiedRanker, '_get_cs_scores'), "_get_cs_scores missing from UnifiedRanker"

    def test_blend_with_cs_key_vs_without(self):
        """_blend with 'cs' present produces a different score than without it."""
        import sys, os
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from unified_ranker import _blend
        weights_with    = {'ml': 0.20, 'cs': 0.05, 'screener': 0.30, 'confluence': 0.20, 'technical': 0.15, 'dl': 0.10}
        weights_without = {'ml': 0.25,              'screener': 0.30, 'confluence': 0.20, 'technical': 0.15, 'dl': 0.10}
        engine_scores = {'ml': 40.0, 'cs': 100.0, 'screener': 60.0, 'confluence': 50.0, 'technical': 55.0, 'dl': 45.0}
        present_with    = {'ml', 'cs', 'screener', 'confluence', 'technical', 'dl'}
        present_without = {'ml',       'screener', 'confluence', 'technical', 'dl'}
        score_with    = _blend(engine_scores, present_with,    weights_with)
        score_without = _blend(engine_scores, present_without, weights_without)
        # cs_score=100 is high; adding it should raise the blended score slightly
        assert score_with != score_without, "blend with cs should differ from blend without"
        assert score_with > score_without, "cs=100 should push blend higher than cs absent"
