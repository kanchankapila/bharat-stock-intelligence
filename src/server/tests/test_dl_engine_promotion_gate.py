"""Regression tests for Finding #70 (2026-07-28 full-stack audit): dl_engine.py's
`--mode train` handler used to unconditionally write `cfg["lstm_version"] = args.version`
regardless of walk-forward validation metrics -- a regression in the new BiLSTM (bad batch,
NaN fold, unlucky init) would go to production automatically the next time run_inference()
read the config, with no comparison against the previously-active version and no backup of
the prior config. Fixed with _promote_lstm_version(): a promotion bar (LSTM_PROMOTION_MARGIN)
plus a timestamped config backup, mirroring ml_ensemble.py's pattern. train_lstm() already
saves each version to its own versioned .pt path, so a rejected version's weights are
naturally preserved as a candidate with no extra file-management needed.
"""
import datetime
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dl_engine as dle


def _iso_days_ago(days: float) -> str:
    return (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()


class TestPromoteLstmVersion:
    def test_nan_roc_auc_refuses_promotion(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        promoted = dle._promote_lstm_version(2, {"roc_auc": float("nan"), "directional_accuracy": 0.55})
        assert promoted is False
        assert not dle.CONFIG_PATH.exists(), "a failed-validation run must not write/activate any config"

    def test_missing_roc_auc_key_refuses_promotion(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        promoted = dle._promote_lstm_version(2, {"error": "no training data"})
        assert promoted is False

    def test_no_prior_active_version_always_promotes(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        promoted = dle._promote_lstm_version(1, {"roc_auc": 0.55, "directional_accuracy": 0.52})
        assert promoted is True
        cfg = json.loads(dle.CONFIG_PATH.read_text())
        assert cfg["lstm_version"] == 1
        assert cfg["lstm_metrics"]["1"]["roc_auc"] == 0.55

    def test_improvement_beyond_margin_promotes_and_backs_up_config(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        dle._promote_lstm_version(1, {"roc_auc": 0.55})
        assert not list(tmp_path.glob("*.bak.json")), "no backup expected on the very first promotion"

        promoted = dle._promote_lstm_version(2, {"roc_auc": 0.60})  # +0.05, clears 0.005 margin
        assert promoted is True
        cfg = json.loads(dle.CONFIG_PATH.read_text())
        assert cfg["lstm_version"] == 2
        backups = list(tmp_path.glob("*.bak.json"))
        assert len(backups) == 1, "promoting over an existing active version must back it up first"

    def test_regression_beyond_margin_is_rejected_and_active_version_unchanged(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        dle._promote_lstm_version(1, {"roc_auc": 0.65})
        promoted = dle._promote_lstm_version(2, {"roc_auc": 0.50})  # well below v1

        assert promoted is False
        cfg = json.loads(dle.CONFIG_PATH.read_text())
        assert cfg["lstm_version"] == 1, "a rejected candidate must not become the active version"
        # metrics are still recorded for future comparisons / inspection
        assert cfg["lstm_metrics"]["2"]["roc_auc"] == 0.50
        assert not list(tmp_path.glob("*.bak.json")), "no backup needed when nothing was promoted"

    def test_tie_within_margin_is_rejected(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        dle._promote_lstm_version(1, {"roc_auc": 0.60})
        promoted = dle._promote_lstm_version(2, {"roc_auc": 0.601})  # +0.001, within the 0.005 margin
        assert promoted is False


class TestSaturationGate:
    """Live bug, 2026-08-10: AUC only measures rank order, not the absolute magnitude of a
    prediction -- a model that outputs ~1.0/~0.0 for nearly everything can still clear the AUC
    bar as long as its rank order happens to be directionally fine. Confirmed live: BiLSTM v4
    (promoted 2026-08-06, this exact gate) jumped from 19% saturated predictions to 70% the very
    next inference day, with output then barely varying day-to-day -- a real regression the
    AUC-only check missed entirely. walk_forward_validate() now also tracks frac_saturated;
    this is the gate that acts on it.
    """

    def test_high_saturation_refuses_promotion_even_with_good_auc(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        # A strong roc_auc alone would otherwise clear the bar -- this is exactly what v4 did.
        promoted = dle._promote_lstm_version(1, {"roc_auc": 0.70, "frac_saturated": 0.70})
        assert promoted is False, "70% saturated predictions must block promotion regardless of roc_auc"
        assert not dle.CONFIG_PATH.exists() or json.loads(dle.CONFIG_PATH.read_text()).get("lstm_version") != 1

    def test_moderate_saturation_at_the_healthy_baseline_still_promotes(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        # 19% was the live-observed healthy baseline (the pre-v4 model) -- must not be blocked.
        promoted = dle._promote_lstm_version(1, {"roc_auc": 0.65, "frac_saturated": 0.19})
        assert promoted is True

    def test_missing_frac_saturated_does_not_block_promotion(self, monkeypatch, tmp_path):
        """Backward compatibility: metrics dicts from before this field existed (or any future
        caller that omits it) must not be treated as a saturation failure."""
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        promoted = dle._promote_lstm_version(1, {"roc_auc": 0.65})
        assert promoted is True

    def test_nan_frac_saturated_does_not_block_promotion(self, monkeypatch, tmp_path):
        """walk_forward_validate() returns NaN frac_saturated when there are no predictions at
        all (n < min_train) -- must fall through to the existing roc_auc-based decision, not be
        treated as a saturation failure."""
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        promoted = dle._promote_lstm_version(1, {"roc_auc": 0.65, "frac_saturated": float("nan")})
        assert promoted is True

    def test_saturation_just_at_ceiling_is_not_blocked(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        monkeypatch.setattr(dle, "CONFIG_PATH", tmp_path / "dl_model_config.json")

        promoted = dle._promote_lstm_version(1, {"roc_auc": 0.65, "frac_saturated": 0.5})
        assert promoted is True, "exactly at the ceiling should not be blocked (only strictly above it)"


class TestStalenessOverride:
    """ml-promotion-gate-review, 2026-08-15: this file's baseline lives in a local JSON
    config, not model_registry, so it had no equivalent to ml_ensemble.py/cs_ranker.py's
    safety valve against a permanently-unbeatable stale baseline."""

    def _seed_stale_baseline(self, config_path, active_version=1, roc_auc=0.65,
                              rejection_count=12, first_rejected_at=None):
        config_path.write_text(json.dumps({
            "lstm_version": active_version,
            "lstm_metrics": {
                str(active_version): {
                    "roc_auc": roc_auc,
                    "rejection_count": rejection_count,
                    "first_rejected_at": first_rejected_at or _iso_days_ago(10),
                },
            },
        }))

    def test_first_rejection_stamps_bookkeeping(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        config_path = tmp_path / "dl_model_config.json"
        monkeypatch.setattr(dle, "CONFIG_PATH", config_path)
        config_path.write_text(json.dumps({"lstm_version": 1, "lstm_metrics": {"1": {"roc_auc": 0.65}}}))

        promoted = dle._promote_lstm_version(2, {"roc_auc": 0.50})  # well below v1

        assert promoted is False
        cfg = json.loads(config_path.read_text())
        assert cfg["lstm_metrics"]["1"]["rejection_count"] == 1
        assert "first_rejected_at" in cfg["lstm_metrics"]["1"]

    def test_stale_and_repeatedly_rejected_baseline_gets_overridden(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        config_path = tmp_path / "dl_model_config.json"
        monkeypatch.setattr(dle, "CONFIG_PATH", config_path)
        self._seed_stale_baseline(config_path)

        promoted = dle._promote_lstm_version(2, {"roc_auc": 0.50})  # doesn't beat baseline

        assert promoted is True, (
            "a candidate that doesn't clear the bar must still be promoted once the baseline "
            "is stale enough AND has been rejected against enough times"
        )
        cfg = json.loads(config_path.read_text())
        assert cfg["lstm_version"] == 2

    def test_stale_but_not_enough_rejections_still_rejects(self, monkeypatch, tmp_path):
        monkeypatch.setattr(dle, "MODEL_DIR", tmp_path)
        config_path = tmp_path / "dl_model_config.json"
        monkeypatch.setattr(dle, "CONFIG_PATH", config_path)
        self._seed_stale_baseline(config_path, rejection_count=1)

        promoted = dle._promote_lstm_version(2, {"roc_auc": 0.50})

        assert promoted is False
        cfg = json.loads(config_path.read_text())
        assert cfg["lstm_version"] == 1
        assert cfg["lstm_metrics"]["1"]["rejection_count"] == 2
