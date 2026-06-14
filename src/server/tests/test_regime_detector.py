import sys
import os
import sqlite3
import numpy as np
import pytest
from unittest.mock import MagicMock
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
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
        for d in dates:
            conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)",
                         ('NIFTY50', d, 21000.0, 21100.0, 20900.0, 21050.0, 1_000_000))
        conn.commit()
        return conn

    def test_features_contain_no_data_after_as_of_date(self):
        """With as_of_date='2024-06-01', feature rows must all be <= that date."""
        from datetime import date, timedelta
        # 40 consecutive daily rows: 2024-04-22 through 2024-05-31 (before cutoff), then some after
        all_dates = [(date(2024, 4, 22) + timedelta(days=i)).isoformat() for i in range(50)]
        conn = self._make_nifty_conn(all_dates)

        df = _load_hmm_features(conn, lookback_days=90, as_of_date='2024-06-01')

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
            _load_hmm_features(conn, lookback_days=30)
        except Exception as e:
            pytest.fail(f"_load_hmm_features without as_of_date raised: {e}")
