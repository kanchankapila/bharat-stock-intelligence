"""Regression tests for Finding #80 (2026-07-28 full-stack audit): movement_predictor.py's
train() used to unconditionally overwrite MODEL_PATH whenever not report_only -- it never
loaded the existing pickle's own stored test_auc to compare against the freshly computed
one, even though the artifact already stores it. score() blindly loads whatever is at
MODEL_PATH, so a retrain that regresses (bad fold, unlucky init) silently replaced a better
production model with a worse one -- the 6th confirmed instance of the no-promotion-gate
pattern in this audit. Fixed with _load_baseline_test_auc()/_movement_promotion_decision(),
mirroring live_screener_ml_ranker.py's PROMOTION_MARGIN pattern.
"""
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from movement_predictor import (
    _load_baseline_test_auc, _movement_promotion_decision, MOVEMENT_PROMOTION_MARGIN,
)


class TestLoadBaselineTestAuc:
    def test_no_existing_model_returns_none(self, tmp_path):
        assert _load_baseline_test_auc(str(tmp_path / "nope.pkl")) is None

    def test_reads_test_auc_from_existing_pickle(self, tmp_path):
        path = tmp_path / "movement.pkl"
        with open(path, "wb") as f:
            pickle.dump({"model": object(), "test_auc": 0.62, "oof_auc": 0.60}, f)
        assert _load_baseline_test_auc(str(path)) == 0.62

    def test_corrupt_pickle_returns_none_not_raise(self, tmp_path):
        path = tmp_path / "movement.pkl"
        path.write_bytes(b"not a pickle")
        assert _load_baseline_test_auc(str(path)) is None


class TestMovementPromotionDecision:
    def test_nan_test_auc_always_refused_even_with_no_baseline(self):
        promote, reason = _movement_promotion_decision(float("nan"), None)
        assert promote is False
        assert "NaN" in reason

    def test_no_baseline_promotes_a_valid_metric(self):
        promote, reason = _movement_promotion_decision(0.55, None)
        assert promote is True
        assert reason is None

    def test_improvement_beyond_margin_promotes(self):
        promote, reason = _movement_promotion_decision(0.65, 0.60)
        assert promote is True

    def test_regression_beyond_margin_is_refused(self):
        promote, reason = _movement_promotion_decision(0.50, 0.60)
        assert promote is False
        assert "did not beat" in reason

    def test_tie_within_margin_is_refused(self):
        promote, reason = _movement_promotion_decision(0.601, 0.60)  # +0.001 < 0.005 margin
        assert promote is False

    def test_exactly_at_margin_promotes(self):
        promote, reason = _movement_promotion_decision(0.60 + MOVEMENT_PROMOTION_MARGIN, 0.60)
        assert promote is True
