"""Regression tests for the 2026-07-30 full-stack audit continuation: breakout_classifier.py's
train() unconditionally overwrote ml_models/breakout.pkl whenever not report_only -- it never
loaded the existing pickle's own stored test_auc to compare against the freshly computed one,
even though the artifact already stores it (same as every OTHER ML file in this codebase,
which all already had this gate: ml_ensemble.py, cs_ranker.py, online_learner.py,
confluence_ml_engine.py, dl_engine.py, movement_predictor.py, ml_signal_scorer.py,
live_screener_ml_ranker.py). This one was missed because it's the single engine with a genuinely
validated live edge (purged-OOF AUC ~0.61, top-decile lift ~1.47x per breakout_position_sizing
memory) -- a silent regression here would be the worst possible model to lose quietly. Fixed
with _load_baseline_test_auc()/_breakout_promotion_decision(), mirroring
movement_predictor.py's identical pattern.
"""
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from breakout_classifier import (
    _load_baseline_test_auc, _breakout_promotion_decision, BREAKOUT_PROMOTION_MARGIN,
)


class TestLoadBaselineTestAuc:
    def test_no_existing_model_returns_none(self, tmp_path):
        assert _load_baseline_test_auc(str(tmp_path / "nope.pkl")) is None

    def test_reads_test_auc_from_existing_pickle(self, tmp_path):
        path = tmp_path / "breakout.pkl"
        with open(path, "wb") as f:
            pickle.dump({"models": [object()], "test_auc": 0.61, "oof_auc": 0.60}, f)
        assert _load_baseline_test_auc(str(path)) == 0.61

    def test_corrupt_pickle_returns_none_not_raise(self, tmp_path):
        path = tmp_path / "breakout.pkl"
        path.write_bytes(b"not a pickle")
        assert _load_baseline_test_auc(str(path)) is None


class TestBreakoutPromotionDecision:
    def test_nan_test_auc_always_refused_even_with_no_baseline(self):
        promote, reason = _breakout_promotion_decision(float("nan"), None)
        assert promote is False
        assert "NaN" in reason

    def test_no_baseline_promotes_a_valid_metric(self):
        promote, reason = _breakout_promotion_decision(0.55, None)
        assert promote is True
        assert reason is None

    def test_improvement_beyond_margin_promotes(self):
        promote, reason = _breakout_promotion_decision(0.65, 0.60)
        assert promote is True

    def test_regression_beyond_margin_is_refused(self):
        promote, reason = _breakout_promotion_decision(0.50, 0.61)
        assert promote is False
        assert "did not beat" in reason

    def test_tie_within_margin_is_refused(self):
        promote, reason = _breakout_promotion_decision(0.611, 0.61)  # +0.001 < 0.005 margin
        assert promote is False

    def test_exactly_at_margin_promotes(self):
        promote, reason = _breakout_promotion_decision(0.61 + BREAKOUT_PROMOTION_MARGIN, 0.61)
        assert promote is True
