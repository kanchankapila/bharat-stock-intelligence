import sys
import os
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.ml_ensemble import (
    incremental_gate_passes, INCREMENTAL_REGRESSION_TOLERANCE,
    incremental_update_predictions_are_finite,
)


class TestIncrementalGate:
    """ml-promotion-gate-review finding (2026-08-14): incremental_update() used to overwrite
    the live ensemble pickle unconditionally, no held-out AUC, no baseline comparison."""

    def test_NEGATIVE_CONTROL_regression_beyond_tolerance_is_rejected(self):
        # Pre-fix code had no gate at all -- this must fail against that (accepts everything).
        assert incremental_gate_passes(0.70, 0.60) is False

    def test_improvement_passes(self):
        assert incremental_gate_passes(0.70, 0.75) is True

    def test_small_regression_within_tolerance_passes(self):
        assert incremental_gate_passes(0.70, 0.70 - INCREMENTAL_REGRESSION_TOLERANCE) is True

    def test_regression_just_beyond_tolerance_fails(self):
        assert incremental_gate_passes(0.70, 0.70 - INCREMENTAL_REGRESSION_TOLERANCE - 0.001) is False

    def test_unchanged_auc_passes(self):
        assert incremental_gate_passes(0.65, 0.65) is True


class TestIncrementalPredictionsFinite:
    """ml-promotion-gate-review finding (2026-08-19): the AUC gate alone can't catch weight/output
    divergence -- the exact class that left 15 of 18 BiLSTM versions ~100% NaN in dl_trainer.py
    while its own metric-only gate stayed silent (recurring-bugs.md)."""

    def test_all_finite_passes(self):
        assert incremental_update_predictions_are_finite(np.array([0.1, 0.5, 0.9])) is True

    def test_NEGATIVE_CONTROL_nan_prediction_is_rejected(self):
        # Pre-fix code had no artifact-level check at all -- this must fail against that.
        assert incremental_update_predictions_are_finite(np.array([0.1, np.nan, 0.9])) is False

    def test_inf_prediction_is_rejected(self):
        assert incremental_update_predictions_are_finite(np.array([0.1, np.inf, 0.9])) is False
