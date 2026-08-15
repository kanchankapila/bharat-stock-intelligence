"""Regression tests for flyer_classifier.py's staleness-override safety valve
(ml-promotion-gate-review, 2026-08-15). This file's baseline lives in a pickle, not
model_registry, so it had no equivalent to ml_ensemble.py/cs_ranker.py's safety valve against a
permanently-unbeatable stale baseline. Mirrors breakout_classifier.py's identical addition.
"""
import datetime
import os
import pickle
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import flyer_classifier as fc


def _iso_days_ago(days: float) -> str:
    return (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()


class TestPromoteOrRejectFlyerStalenessOverride:
    def _write_baseline(self, path, test_auc=0.61, **extra):
        with open(path, "wb") as f:
            pickle.dump({"models": [object()], "test_auc": test_auc, "oof_auc": 0.60, **extra}, f)

    def test_first_rejection_stamps_bookkeeping_onto_the_baseline_file(self, monkeypatch, tmp_path):
        model_path = tmp_path / "flyer.pkl"
        candidate_path = tmp_path / "flyer.pkl.candidate"
        monkeypatch.setattr(fc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(fc, "CANDIDATE_PATH", str(candidate_path))
        self._write_baseline(model_path, test_auc=0.61)

        promoted = fc._promote_or_reject_flyer({"test_auc": 0.50}, test_auc=0.50, auc=0.50)

        assert promoted is False
        assert candidate_path.exists()
        with open(model_path, "rb") as f:
            baseline = pickle.load(f)
        assert baseline["rejection_count"] == 1
        assert "first_rejected_at" in baseline

    def test_stale_and_repeatedly_rejected_baseline_gets_overridden(self, monkeypatch, tmp_path):
        model_path = tmp_path / "flyer.pkl"
        candidate_path = tmp_path / "flyer.pkl.candidate"
        monkeypatch.setattr(fc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(fc, "CANDIDATE_PATH", str(candidate_path))
        self._write_baseline(model_path, test_auc=0.61, rejection_count=12,
                              first_rejected_at=_iso_days_ago(10))

        promoted = fc._promote_or_reject_flyer({"test_auc": 0.50}, test_auc=0.50, auc=0.50)

        assert promoted is True
        with open(model_path, "rb") as f:
            activated = pickle.load(f)
        assert activated == {"test_auc": 0.50}

    def test_stale_but_not_enough_rejections_still_rejects(self, monkeypatch, tmp_path):
        model_path = tmp_path / "flyer.pkl"
        candidate_path = tmp_path / "flyer.pkl.candidate"
        monkeypatch.setattr(fc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(fc, "CANDIDATE_PATH", str(candidate_path))
        self._write_baseline(model_path, test_auc=0.61, rejection_count=1,
                              first_rejected_at=_iso_days_ago(10))

        promoted = fc._promote_or_reject_flyer({"test_auc": 0.50}, test_auc=0.50, auc=0.50)

        assert promoted is False

    def test_no_baseline_bootstraps_without_bookkeeping(self, monkeypatch, tmp_path):
        model_path = tmp_path / "flyer.pkl"
        candidate_path = tmp_path / "flyer.pkl.candidate"
        monkeypatch.setattr(fc, "MODEL_PATH", str(model_path))
        monkeypatch.setattr(fc, "CANDIDATE_PATH", str(candidate_path))

        promoted = fc._promote_or_reject_flyer({"test_auc": 0.55}, test_auc=0.55, auc=0.55)

        assert promoted is True
        assert model_path.exists()
