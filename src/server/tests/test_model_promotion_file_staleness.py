"""Tests for model_promotion.file_staleness_override_applies() -- the pickle/JSON-file
equivalent of staleness_override_applies(), added 2026-08-15 (ml-promotion-gate-review) for the
5 engines whose promotion gate has no model_registry connection to call rejections_since()
against: dl_engine.py, live_screener_ml_ranker.py, breakout_classifier.py, flyer_classifier.py,
movement_predictor.py.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from model_promotion import file_staleness_override_applies


def _iso_days_ago(days: float) -> str:
    return (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()


class TestFileStalenessOverrideApplies:
    def test_no_baseline_never_overrides(self):
        applies, age, count = file_staleness_override_applies(None)
        assert applies is False
        assert age == 0.0
        assert count == 0

    def test_baseline_never_rejected_never_overrides(self):
        applies, age, count = file_staleness_override_applies({"test_auc": 0.61})
        assert applies is False
        assert count == 0

    def test_stale_and_repeatedly_rejected_overrides(self):
        baseline = {
            "test_auc": 0.61,
            "first_rejected_at": _iso_days_ago(10),
            "rejection_count": 12,
        }
        applies, age, count = file_staleness_override_applies(baseline)
        assert applies is True
        assert age >= 9.9
        assert count == 12

    def test_stale_but_not_enough_rejections_does_not_override(self):
        baseline = {
            "test_auc": 0.61,
            "first_rejected_at": _iso_days_ago(10),
            "rejection_count": 3,
        }
        applies, age, count = file_staleness_override_applies(baseline)
        assert applies is False

    def test_enough_rejections_but_not_stale_does_not_override(self):
        baseline = {
            "test_auc": 0.61,
            "first_rejected_at": _iso_days_ago(1),
            "rejection_count": 20,
        }
        applies, age, count = file_staleness_override_applies(baseline)
        assert applies is False

    def test_both_conditions_required_not_either(self):
        """The safety valve must not fire on age alone or rejection count alone -- mirrors
        the DB-backed staleness_override_applies()'s own contract."""
        just_stale = file_staleness_override_applies(
            {"first_rejected_at": _iso_days_ago(30), "rejection_count": 1})
        just_many_rejections = file_staleness_override_applies(
            {"first_rejected_at": _iso_days_ago(0.1), "rejection_count": 50})
        assert just_stale[0] is False
        assert just_many_rejections[0] is False

    def test_custom_thresholds_respected(self):
        baseline = {"first_rejected_at": _iso_days_ago(2), "rejection_count": 3}
        applies, _, _ = file_staleness_override_applies(baseline, max_days=1, max_rejections=2)
        assert applies is True
