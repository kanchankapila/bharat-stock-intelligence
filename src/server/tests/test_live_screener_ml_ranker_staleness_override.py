"""Regression tests for live_screener_ml_ranker.py's staleness-override safety valve
(ml-promotion-gate-review, 2026-08-15). This file's baseline lives in a pickle, not
model_registry, so it had no equivalent to ml_ensemble.py/cs_ranker.py's safety valve against a
permanently-unbeatable stale baseline.
"""
import datetime
import os
import pickle
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_screener_ml_ranker as lsmr


def _iso_days_ago(days: float) -> str:
    return (datetime.datetime.now() - datetime.timedelta(days=days)).isoformat()


class TestBumpRejectionBookkeeping:
    def test_no_existing_model_is_a_safe_no_op(self, tmp_path):
        assert lsmr._bump_rejection_bookkeeping(str(tmp_path / "nope.pkl")) == 0

    def test_first_rejection_stamps_bookkeeping_preserving_the_rest_of_the_artifact(self, tmp_path):
        model_path = tmp_path / "model.pkl"
        with open(model_path, "wb") as f:
            pickle.dump({"model": object(), "test_auc": 0.64, "feature_names": ["f0", "f1"]}, f)

        count = lsmr._bump_rejection_bookkeeping(str(model_path))

        assert count == 1
        with open(model_path, "rb") as f:
            art = pickle.load(f)
        assert art["rejection_count"] == 1
        assert "first_rejected_at" in art
        assert art["test_auc"] == 0.64, "the live model's own metrics must not change"
        assert art["feature_names"] == ["f0", "f1"], "the live model itself must not be discarded"

    def test_repeated_rejections_increment_without_resetting_first_rejected_at(self, tmp_path):
        model_path = tmp_path / "model.pkl"
        first_rejected = _iso_days_ago(5)
        with open(model_path, "wb") as f:
            pickle.dump({"test_auc": 0.64, "rejection_count": 3, "first_rejected_at": first_rejected}, f)

        count = lsmr._bump_rejection_bookkeeping(str(model_path))

        assert count == 4
        with open(model_path, "rb") as f:
            art = pickle.load(f)
        assert art["first_rejected_at"] == first_rejected


def _synthetic_training_frame(n_dates=20, symbols_per_day=15):
    """Same builder as test_live_screener_ml_ranker_live_edge_status.py."""
    dates = pd.bdate_range("2026-06-01", periods=n_dates).strftime("%Y-%m-%d")
    rows = []
    rng = np.random.default_rng(42)
    for run_id, d in enumerate(dates, start=1):
        run_ts = pd.Timestamp(f"{d}T05:00:00", tz="UTC")
        for i in range(symbols_per_day):
            change_per = float(rng.normal(0, 2))
            volume = float(rng.integers(10_000, 1_000_000))
            filter_key = "RSI_OVERSOLD" if i % 3 == 0 else "VOLUME_SURGE"
            return_intraday = change_per / 100.0 + float(rng.normal(0, 0.01))
            rows.append({
                "symbol": f"SYM{i}", "filter_key": filter_key, "appeared_at": d, "run_id": run_id,
                "run_ts": run_ts,
                "return_intraday": return_intraday, "change_per": change_per, "volume": volume,
            })
    return pd.DataFrame(rows)


class TestTrainStalenessOverrideWiring:
    """Wiring check, not just the helpers in isolation: train() must actually consult the
    override and activate the candidate when it fires, even against an impossibly high
    baseline test_auc that could otherwise never be beaten."""

    def _patch_common(self, monkeypatch, tmp_path):
        monkeypatch.setattr(lsmr, "MODEL_PATH", str(tmp_path / "model.pkl"))
        monkeypatch.setattr(lsmr, "CANDIDATE_PATH", str(tmp_path / "model_candidate.pkl"))
        monkeypatch.setattr(lsmr, "_load_training_frame", lambda: _synthetic_training_frame())
        monkeypatch.setattr(lsmr, "_persist_live_edge_status", lambda *a, **k: None)
        monkeypatch.setattr(lsmr, "_live_auc", lambda: (None, 0))

    def test_stale_and_repeatedly_rejected_baseline_gets_overridden(self, monkeypatch, tmp_path):
        self._patch_common(monkeypatch, tmp_path)
        monkeypatch.setattr(lsmr, "_load_active_metrics", lambda: {
            "trained_at": "2026-01-01T00:00:00", "test_auc": 0.999,  # impossible to beat
            "rejection_count": 12, "first_rejected_at": _iso_days_ago(10),
        })

        lsmr.train()

        assert os.path.exists(lsmr.MODEL_PATH), (
            "a candidate that can't clear an impossible baseline must still be promoted once "
            "the baseline is stale enough AND has been rejected against enough times"
        )

    def test_stale_but_not_enough_rejections_still_rejects(self, monkeypatch, tmp_path):
        self._patch_common(monkeypatch, tmp_path)
        monkeypatch.setattr(lsmr, "_load_active_metrics", lambda: {
            "trained_at": "2026-01-01T00:00:00", "test_auc": 0.999,
            "rejection_count": 1, "first_rejected_at": _iso_days_ago(10),
        })

        lsmr.train()

        assert not os.path.exists(lsmr.MODEL_PATH), "staleness alone must not override"
        assert os.path.exists(lsmr.CANDIDATE_PATH)
