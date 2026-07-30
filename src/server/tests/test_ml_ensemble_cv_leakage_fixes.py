import sys
import os
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.ml_ensemble import REGIME_MAP, _compute_holdout_split


class TestRegimeMapFinding19:
    """Finding #19: HIGH_VOL/CRASH must not collapse into SIDEWAYS's 0.0 encoding."""

    def test_all_five_regimes_present(self):
        assert set(REGIME_MAP.keys()) == {'BULL', 'SIDEWAYS', 'HIGH_VOL', 'BEAR', 'CRASH'}

    def test_all_five_values_distinct(self):
        values = list(REGIME_MAP.values())
        assert len(values) == len(set(values)), "every regime must get its own encoding"

    def test_high_vol_and_crash_not_zero(self):
        # The bug: both used to fall through .fillna(0.0) and read as SIDEWAYS.
        assert REGIME_MAP['HIGH_VOL'] != 0.0
        assert REGIME_MAP['CRASH'] != 0.0

    def test_unknown_regime_still_falls_back_to_neutral(self):
        raw = pd.Series(['BULL', 'HIGH_VOL', 'CRASH', 'GARBAGE'])
        encoded = raw.map(REGIME_MAP).fillna(0.0)
        assert encoded.iloc[3] == 0.0  # genuinely-unknown regimes stay at the neutral fallback
        assert encoded.iloc[1] != encoded.iloc[3]  # but HIGH_VOL no longer looks like "unknown"
        assert encoded.iloc[2] != encoded.iloc[3]  # neither does CRASH


class TestComputeHoldoutSplitFinding18:
    """Finding #18: hyperparameter tuning must only see rows before the held-out test/val
    window train_ensemble() later reports metrics on — this is the shared boundary helper
    both tune (run()) and train (train_ensemble()) now call, so they can't drift apart."""

    def _make_dated_frame(self, n_days=60, rows_per_day=20):
        dates = []
        for d in range(n_days):
            dates.extend([f"2026-01-{d+1:02d}" if d < 31 else f"2026-02-{d-30:02d}"] * rows_per_day)
        n = len(dates)
        X = pd.DataFrame({'horizon_days': [15] * n, 'f1': np.random.randn(n)})
        return X, pd.Series(dates)

    def test_tr_end_leaves_room_for_test_and_val(self):
        X, dates = self._make_dated_frame()
        tr_end, n_test, n_val = _compute_holdout_split(X, dates, embargo=0, min_samples=30)
        assert n_test > 0 and n_val > 0
        assert tr_end < len(X)
        # Nothing in the training slice should share a date with the test window.
        test_dates = set(dates.iloc[tr_end + n_val:])
        train_dates = set(dates.iloc[:tr_end])
        assert train_dates.isdisjoint(test_dates)

    def test_no_holdout_when_too_few_dates(self):
        X = pd.DataFrame({'horizon_days': [15] * 10, 'f1': np.random.randn(10)})
        dates = pd.Series([f"2026-01-{i+1:02d}" for i in range(10)])
        tr_end, n_test, n_val = _compute_holdout_split(X, dates, embargo=0, min_samples=30)
        assert n_test == 0 and n_val == 0
        assert tr_end == len(X)  # falls back to "train on everything" — matches train_ensemble

    def test_tr_end_matches_train_ensemble_boundary(self):
        """The exact regression this finding is about: a caller computing tr_end via this
        helper must land on the identical boundary train_ensemble()'s own logic uses, so
        tuning and the final reported test/val split never disagree."""
        X, dates = self._make_dated_frame()
        embargo = 5
        tr_end, n_test, n_val = _compute_holdout_split(X, dates, embargo=embargo, min_samples=30)
        assert tr_end == len(X) - n_test - n_val - embargo
