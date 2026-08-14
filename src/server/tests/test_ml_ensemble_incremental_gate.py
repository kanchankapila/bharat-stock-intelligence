import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.ml_ensemble import incremental_gate_passes, INCREMENTAL_REGRESSION_TOLERANCE


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
