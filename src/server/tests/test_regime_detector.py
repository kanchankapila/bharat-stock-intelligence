import sys
import os
import sqlite3
import numpy as np
import pandas as pd
import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
import src.server.regime_detector as regime_detector
from src.server.regime_detector import _assign_state_labels, _load_hmm_features


def _make_mock_hmm(return_means, vol_means):
    """Build a mock HMM whose means_ matrix has given return and vol values per state."""
    model = MagicMock()
    n = len(return_means)
    means = np.zeros((n, 8))
    means[:, 0] = return_means   # nifty_ret_21d
    means[:, 1] = vol_means      # nifty_vol_21d
    model.means_ = means
    return model


class TestLabelAssignment:
    def test_highest_return_state_is_bull(self):
        model = _make_mock_hmm(
            return_means=[0.03, 0.01, -0.01, -0.03, -0.05],
            vol_means=[0.12, 0.15, 0.18, 0.20, 0.35],
        )
        labels = _assign_state_labels(model)
        bull_state = [k for k, v in labels.items() if v == 'BULL'][0]
        assert model.means_[bull_state, 0] == max(model.means_[:, 0])

    def test_highest_vol_bottom_state_is_crash(self):
        model = _make_mock_hmm(
            return_means=[0.03, 0.01, -0.01, -0.03, -0.05],
            vol_means=[0.12, 0.15, 0.18, 0.20, 0.35],
        )
        labels = _assign_state_labels(model)
        # State 4 (highest vol among bottom 2 by return) must be CRASH
        assert labels[4] == 'CRASH'
        # State 3 (lower vol bottom state) must be BEAR
        assert labels[3] == 'BEAR'

    def test_label_switching_resilience(self):
        """After reorder, BEAR always has lower vol than CRASH across random configurations."""
        for seed in range(10):
            rng = np.random.default_rng(seed)
            returns = sorted(rng.uniform(-0.05, 0.05, 5), reverse=True)
            vols    = rng.uniform(0.10, 0.50, 5)
            model   = _make_mock_hmm(returns, vols)
            labels  = _assign_state_labels(model)

            bear_idx  = [k for k, v in labels.items() if v == 'BEAR'][0]
            crash_idx = [k for k, v in labels.items() if v == 'CRASH'][0]
            assert model.means_[bear_idx, 1] <= model.means_[crash_idx, 1], (
                f"Seed {seed}: BEAR vol ({model.means_[bear_idx,1]:.3f}) "
                f"should be <= CRASH vol ({model.means_[crash_idx,1]:.3f})"
            )

    def test_swap_triggered_when_lower_return_has_higher_vol(self):
        """Fixture where the second-lowest-return state has HIGHER vol than the lowest-return state.
        The swap must fire so that CRASH ends up with the higher-vol state (index 3 here)."""
        # returns sorted descending: state 0 > 1 > 2 > 3 > 4
        # vol: state 3 has 0.35 (higher), state 4 has 0.20 (lower)
        # Without the swap: state 4 would be CRASH (wrong — lower vol)
        # After the swap:   state 3 should be CRASH (correct — higher vol)
        model = _make_mock_hmm(
            return_means=[0.03, 0.01, -0.01, -0.03, -0.05],
            vol_means=[0.12, 0.15, 0.18, 0.35, 0.20],
        )
        labels = _assign_state_labels(model)
        assert labels[3] == 'CRASH', f"Expected state 3 (vol=0.35) to be CRASH, got {labels[3]}"
        assert labels[4] == 'BEAR',  f"Expected state 4 (vol=0.20) to be BEAR, got {labels[4]}"


class TestDateAnchoredFeatures:
    def _make_nifty_conn(self, dates):
        conn = sqlite3.connect(':memory:')
        conn.execute("""
            CREATE TABLE stock_ohlcv (
                symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER
            )
        """)
        conn.execute("CREATE TABLE fii_dii_flow (date TEXT, fii_net REAL)")
        conn.execute("""
            CREATE TABLE market_sentiment_snapshots (
                snapshot_at TEXT, overall_score REAL
            )
        """)
        conn.execute("CREATE TABLE macro_asset_prices (symbol TEXT, date TEXT, close REAL, ret_5d REAL)")
        conn.execute("CREATE TABLE market_breadth (date TEXT PRIMARY KEY, adv_decline_ratio REAL)")
        for d in dates:
            conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)",
                         ('NIFTY50', d, 21000.0, 21100.0, 20900.0, 21050.0, 1_000_000))
            conn.execute("INSERT INTO market_breadth (date, adv_decline_ratio) VALUES (?,?)", (d, 0.55))
        conn.commit()
        return conn

    def _patched_read_df(self, conn):
        """Route regime_detector.read_df through the in-memory test conn.

        _load_hmm_features no longer takes a conn (P3f routed it through the
        db_compat.read_df global); we inject the test data by patching that global.
        """
        def _read(sql, params=()):
            return pd.read_sql_query(sql, conn, params=tuple(params))
        return _read

    def test_features_contain_no_data_after_as_of_date(self):
        """With as_of_date='2024-06-01', feature rows must all be <= that date."""
        from datetime import date, timedelta
        # 50 consecutive daily rows spanning before and after the 2024-06-01 cutoff
        all_dates = [(date(2024, 4, 22) + timedelta(days=i)).isoformat() for i in range(50)]
        conn = self._make_nifty_conn(all_dates)

        with patch.object(regime_detector, 'read_df', self._patched_read_df(conn)):
            df = _load_hmm_features(lookback_days=90, as_of_date='2024-06-01')

        # Rolling window needs 21 rows, so df should NOT be empty
        assert not df.empty, (
            "Expected non-empty feature DataFrame with 50 consecutive daily NIFTY50 rows"
        )
        max_date = df.index.max()
        assert str(max_date.date()) <= '2024-06-01', (
            f"Feature data contains future rows beyond as_of_date: {max_date}"
        )

    def test_default_as_of_date_uses_today(self):
        """_load_hmm_features without as_of_date should not raise."""
        conn = self._make_nifty_conn([])
        try:
            with patch.object(regime_detector, 'read_df', self._patched_read_df(conn)):
                _load_hmm_features(lookback_days=30)
        except Exception as e:
            pytest.fail(f"_load_hmm_features without as_of_date raised: {e}")

    def test_advance_decline_sourced_from_market_breadth(self):
        from datetime import date, timedelta
        all_dates = [(date(2024, 4, 22) + timedelta(days=i)).isoformat() for i in range(50)]
        conn = self._make_nifty_conn(all_dates)
        with patch.object(regime_detector, 'read_df', self._patched_read_df(conn)):
            df = _load_hmm_features(lookback_days=90, as_of_date='2024-06-01')
        assert (df['advance_decline_ratio'] == 0.55).all()


class TestLogLikelihoodPerSample:
    """Two GaussianHMMs fit with different StandardScalers aren't comparable via raw
    model.score() -- each scaler's fitted std shifts the density by a Jacobian term. This
    correction is what makes the promotion-gate comparison below apples-to-apples."""

    def test_jacobian_correction_matches_manual_calc(self):
        model = MagicMock()
        model.score.return_value = 100.0  # sum log-lik in transformed space, n=4 samples
        scaler = MagicMock()
        scaler.transform.side_effect = lambda X: X  # identity, isolates the Jacobian term
        scaler.scale_ = np.array([2.0, 4.0])
        X = np.zeros((4, 2))
        result = regime_detector._log_likelihood_per_sample(model, scaler, X)
        expected = (100.0 - 4 * (np.log(2.0) + np.log(4.0))) / 4
        assert result == pytest.approx(expected)

    def test_empty_input_returns_negative_infinity(self):
        model, scaler = MagicMock(), MagicMock()
        result = regime_detector._log_likelihood_per_sample(model, scaler, np.zeros((0, 2)))
        assert result == float('-inf')


class TestTrainHmmPromotionGate:
    """2026-08-01 audit sweep: train_hmm() unconditionally overwrote hmm_regime.pkl with no
    held-out comparison, no model_registry entry, and no stability check -- unlike every
    sibling ML file in this codebase. This model's daily label drives REGIME_WEIGHTS in
    unified_ranker.py, the largest single blend-switch in the whole ranker."""

    @staticmethod
    def _synthetic_features(n=340, seed=0):
        rng = np.random.default_rng(seed)
        idx = pd.date_range('2024-01-01', periods=n, freq='D')
        cols = ['nifty_ret_21d', 'nifty_vol_21d', 'nifty_vix', 'fii_5d_net_norm',
                'advance_decline_ratio', 'us10y_chg5d', 'dxy_ret_5d', 'sp500_ret_5d']
        data = {c: rng.normal(loc=i, scale=1.0, size=n) for i, c in enumerate(cols)}
        return pd.DataFrame(data, index=idx)

    def test_first_ever_train_promotes_without_prior_model(self, tmp_path, monkeypatch):
        hmm_path = tmp_path / "hmm_regime.pkl"
        monkeypatch.setattr(regime_detector, 'HMM_PATH', hmm_path)
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days: self._synthetic_features())
        result = regime_detector.train_hmm(holdout_days=60)
        assert result['promotion']['promoted'] is True
        assert hmm_path.exists()
        assert not (tmp_path / "hmm_regime.pkl.candidate").exists()

    def test_insufficient_data_for_holdout_still_promotes(self, tmp_path, monkeypatch):
        """Below holdout_days+252 rows, effective_holdout collapses to 0 -- the gate must not
        block a legitimate train just because there isn't enough data to hold out yet."""
        hmm_path = tmp_path / "hmm_regime.pkl"
        monkeypatch.setattr(regime_detector, 'HMM_PATH', hmm_path)
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days: self._synthetic_features(n=260))
        regime_detector.train_hmm(holdout_days=60)  # seed a prior model
        result = regime_detector.train_hmm(holdout_days=60)
        assert result['promotion']['promoted'] is True
        assert result['promotion']['reason'] == 'no_prior_model_or_no_holdout'

    def test_forced_train_always_promotes(self, tmp_path, monkeypatch):
        hmm_path = tmp_path / "hmm_regime.pkl"
        monkeypatch.setattr(regime_detector, 'HMM_PATH', hmm_path)
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days: self._synthetic_features())
        regime_detector.train_hmm(holdout_days=60)
        result = regime_detector.train_hmm(holdout_days=60, force=True)
        assert result['promotion']['promoted'] is True
        assert result['promotion']['reason'] == 'forced'

    def test_regressing_retrain_is_rejected_to_candidate_file(self, tmp_path, monkeypatch):
        hmm_path = tmp_path / "hmm_regime.pkl"
        monkeypatch.setattr(regime_detector, 'HMM_PATH', hmm_path)
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days: self._synthetic_features())
        regime_detector.train_hmm(holdout_days=60)  # seed a live model
        prior_bytes = hmm_path.read_bytes()

        # train_hmm calls _log_likelihood_per_sample(new, ...) before (prior, ...) -- the
        # first return is new_ll, the second is old_ll. new < old => a genuine regression.
        monkeypatch.setattr(regime_detector, '_log_likelihood_per_sample',
                             MagicMock(side_effect=[5.0, 10.0]))

        result = regime_detector.train_hmm(holdout_days=60)

        assert result['promotion']['promoted'] is False
        assert hmm_path.read_bytes() == prior_bytes, "live model must be untouched on regression"
        assert (tmp_path / "hmm_regime.pkl.candidate").exists(), \
            "rejected candidate must still be saved for inspection"

    def test_improving_retrain_is_promoted(self, tmp_path, monkeypatch):
        hmm_path = tmp_path / "hmm_regime.pkl"
        monkeypatch.setattr(regime_detector, 'HMM_PATH', hmm_path)
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days: self._synthetic_features(seed=0))
        regime_detector.train_hmm(holdout_days=60)
        prior_bytes = hmm_path.read_bytes()

        # Different seed -> a genuinely different fitted model, so a promoted overwrite is
        # actually detectable on disk (same seed would refit to byte-identical output).
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days: self._synthetic_features(seed=1))
        monkeypatch.setattr(regime_detector, '_log_likelihood_per_sample',
                             MagicMock(side_effect=[10.0, 5.0]))  # new > old

        result = regime_detector.train_hmm(holdout_days=60)
        assert result['promotion']['promoted'] is True
        assert hmm_path.read_bytes() != prior_bytes, "live model must be updated on improvement"
