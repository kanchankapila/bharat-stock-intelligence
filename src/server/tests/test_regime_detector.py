import sys
import os
import pickle
import sqlite3
import numpy as np
import pandas as pd
import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
import src.server.regime_detector as regime_detector
from src.server.regime_detector import _assign_state_labels, _load_hmm_features


class _PicklableModel:
    """Minimal stand-in for a fitted GaussianHMM, picklable (unlike MagicMock) so it can be
    round-tripped through a real HMM_PATH file the way backfill_regimes/update_regime do."""
    def predict(self, X):
        return np.zeros(len(X), dtype=int)

    def predict_proba(self, X):
        return np.tile([0.9, 0.02, 0.02, 0.03, 0.03], (len(X), 1))


class _PicklableScaler:
    def transform(self, X):
        return X.values if hasattr(X, "values") else X


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


class TestSilentNoWriteGuards:
    """2026-08 job-health investigation: market_regimes' MAX(computed_at) was found frozen
    for weeks with no error anywhere in job_heartbeat/BullMQ. update_regime()'s two silent
    no-write paths (missing model file, empty feature window) both used to `print` + `return
    "SIDEWAYS"` -- a clean exit 0 that never touched market_regimes, and "SIDEWAYS" is also a
    legitimate real regime label, so the return value alone could never distinguish "wrote a
    real SIDEWAYS day" from "wrote nothing at all". Both must now fail loudly on the live
    daily cron path, while backfill_regimes keeps its per-day skip tolerance (sparse
    historical gaps near the start of stock_ohlcv's own history are expected there)."""

    def test_label_day_raises_on_empty_features(self, monkeypatch):
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days=None, as_of_date=None: pd.DataFrame())
        with pytest.raises(regime_detector.NoRegimeData):
            regime_detector._label_day(MagicMock(), MagicMock(), {}, "2026-07-05")

    def test_update_regime_raises_when_no_model(self, tmp_path, monkeypatch):
        monkeypatch.setattr(regime_detector, 'HMM_PATH', tmp_path / "does_not_exist.pkl")
        with pytest.raises(RuntimeError, match="No model"):
            regime_detector.update_regime("2026-07-05")

    def test_update_regime_raises_when_features_empty(self, tmp_path, monkeypatch):
        hmm_path = tmp_path / "hmm_regime.pkl"
        with open(hmm_path, "wb") as f:
            pickle.dump({"model": None, "scaler": None, "state_labels": {}}, f)
        monkeypatch.setattr(regime_detector, 'HMM_PATH', hmm_path)
        monkeypatch.setattr(regime_detector, '_load_hmm_features',
                             lambda lookback_days=None, as_of_date=None: pd.DataFrame())

        with pytest.raises(regime_detector.NoRegimeData):
            regime_detector.update_regime("2026-07-05")

    def test_backfill_skips_empty_days_instead_of_raising(self, tmp_path, monkeypatch):
        """A day with no feature data must be skipped, not abort the whole backfill --
        the opposite contract from update_regime's live daily path."""
        def fake_load(lookback_days=None, as_of_date=None):
            # Day 2 has no data available; days 1 and 3 do.
            if as_of_date == "2026-01-02":
                return pd.DataFrame()
            idx = pd.date_range("2025-01-01", periods=5, freq="D")
            return pd.DataFrame({
                "nifty_ret_21d": [0.01] * 5, "nifty_vol_21d": [0.1] * 5,
                "nifty_vix": [15.0] * 5, "fii_5d_net_norm": [0.0] * 5,
                "advance_decline_ratio": [1.0] * 5, "us10y_chg5d": [0.0] * 5,
                "dxy_ret_5d": [0.0] * 5, "sp500_ret_5d": [0.0] * 5,
            }, index=idx)

        monkeypatch.setattr(regime_detector, '_load_hmm_features', fake_load)
        monkeypatch.setattr(regime_detector, '_read_dated',
                             lambda sql, params: pd.DataFrame(
                                 index=pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-03"])))
        monkeypatch.setattr(regime_detector, 'execute', MagicMock())

        # backfill_regimes unpickles HMM_PATH for real -- MagicMock isn't picklable, so use a
        # plain picklable stand-in with just the two methods _label_day actually calls.
        model = _PicklableModel()
        scaler = _PicklableScaler()
        state_labels = {0: "BULL", 1: "SIDEWAYS", 2: "HIGH_VOL", 3: "BEAR", 4: "CRASH"}

        hmm_path = tmp_path / "hmm_regime.pkl"
        with open(hmm_path, "wb") as f:
            pickle.dump({"model": model, "scaler": scaler, "state_labels": state_labels}, f)
        monkeypatch.setattr(regime_detector, 'HMM_PATH', hmm_path)

        n = regime_detector.backfill_regimes("2026-01-01", "2026-01-03")
        assert n == 2, f"expected 2 successful days (1 skipped), got {n}"
