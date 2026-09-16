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
import datetime
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import breakout_classifier as bc
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


def _iso_days_ago(days: float) -> str:
    return (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()


class TestPromoteOrRejectBreakoutStalenessOverride:
    """ml-promotion-gate-review, 2026-08-15: this file's baseline lives in a pickle, not
    model_registry, so it had no equivalent to ml_ensemble.py/cs_ranker.py's safety valve
    against a permanently-unbeatable stale baseline."""

    def _write_baseline(self, path, test_auc=0.61, **extra):
        with open(path, "wb") as f:
            pickle.dump({"models": [object()], "test_auc": test_auc, "oof_auc": 0.60, **extra}, f)

    def test_first_rejection_stamps_bookkeeping_onto_the_baseline_file(self, monkeypatch, tmp_path):
        model_path = tmp_path / "breakout.pkl"
        candidate_path = tmp_path / "breakout.pkl.candidate"
        monkeypatch.setattr(bc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(bc, "CANDIDATE_PATH", str(candidate_path))
        self._write_baseline(model_path, test_auc=0.61)

        promoted = bc._promote_or_reject_breakout({"test_auc": 0.50}, test_auc=0.50, auc=0.50)

        assert promoted is False
        assert candidate_path.exists()
        with open(model_path, "rb") as f:
            baseline = pickle.load(f)
        assert baseline["rejection_count"] == 1
        assert "first_rejected_at" in baseline
        assert baseline["test_auc"] == 0.61, "the baseline's own metrics must not change, only bookkeeping"

    def test_repeated_rejections_increment_count_without_resetting_first_rejected_at(self, monkeypatch, tmp_path):
        model_path = tmp_path / "breakout.pkl"
        candidate_path = tmp_path / "breakout.pkl.candidate"
        monkeypatch.setattr(bc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(bc, "CANDIDATE_PATH", str(candidate_path))
        first_rejected = _iso_days_ago(5)
        self._write_baseline(model_path, test_auc=0.61, rejection_count=3, first_rejected_at=first_rejected)

        bc._promote_or_reject_breakout({"test_auc": 0.50}, test_auc=0.50, auc=0.50)

        with open(model_path, "rb") as f:
            baseline = pickle.load(f)
        assert baseline["rejection_count"] == 4
        assert baseline["first_rejected_at"] == first_rejected

    def test_stale_and_repeatedly_rejected_baseline_gets_overridden(self, monkeypatch, tmp_path):
        model_path = tmp_path / "breakout.pkl"
        candidate_path = tmp_path / "breakout.pkl.candidate"
        monkeypatch.setattr(bc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(bc, "CANDIDATE_PATH", str(candidate_path))
        self._write_baseline(model_path, test_auc=0.61, rejection_count=12,
                              first_rejected_at=_iso_days_ago(10))

        promoted = bc._promote_or_reject_breakout({"test_auc": 0.50}, test_auc=0.50, auc=0.50)

        assert promoted is True, (
            "a candidate that doesn't clear the bar must still be promoted once the baseline "
            "is stale enough AND has been rejected against enough times"
        )
        with open(model_path, "rb") as f:
            activated = pickle.load(f)
        assert activated == {"test_auc": 0.50}, "the override promotes the CANDIDATE, not the stale baseline"

    def test_stale_but_not_enough_rejections_still_rejects(self, monkeypatch, tmp_path):
        model_path = tmp_path / "breakout.pkl"
        candidate_path = tmp_path / "breakout.pkl.candidate"
        monkeypatch.setattr(bc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(bc, "CANDIDATE_PATH", str(candidate_path))
        self._write_baseline(model_path, test_auc=0.61, rejection_count=1,
                              first_rejected_at=_iso_days_ago(10))

        promoted = bc._promote_or_reject_breakout({"test_auc": 0.50}, test_auc=0.50, auc=0.50)

        assert promoted is False, "staleness alone must not override -- both conditions are required"
