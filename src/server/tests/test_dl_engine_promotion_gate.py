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
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dl_engine as dle


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
