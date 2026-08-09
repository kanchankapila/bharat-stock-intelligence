"""Regression test for the 2026-08-07 fix: live_screener_ml_ranker.py's live_auc/
live_edge_proven fields (a real-time health check on whichever model is CURRENTLY DEPLOYED
and scoring live_screener_ml_scores every 15 min) used to be persisted to
app_settings.live_screener_ml_model_status only inside train()'s `if promote:` branch.

Since scoring always reads MODEL_PATH regardless of whether that day's retrain promotes, this
health signal describes the deployed model, not the day's candidate -- but as long as
promotion kept failing (live-confirmed 2026-08-07: the deployed model's real AUC is 0.4615 over
671,257 resolved rows, essentially no edge, so every subsequent candidate also fails to clear
the resulting elevated STRICT_PROMOTION_MARGIN), the one signal that could tell
monitor.router.ts's "Intraday Edge" tab the deployed model isn't trustworthy never reached
app_settings at all -- the tab kept rendering a confidently color-coded "ML XX%" badge for a
model with no real live skill.

_persist_live_edge_status() is the extracted fix: called unconditionally on every --train run
(both promote and reject branches), refreshing live_auc/live_edge_proven while preserving the
DEPLOYED model's own trained_at/cv_auc/test_auc/etc. (never overwriting them with a rejected
candidate's numbers).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_screener_ml_ranker as lsmr


class _ExecuteCapture:
    def __init__(self):
        self.calls = []

    def __call__(self, sql, params=None):
        self.calls.append((sql, params))

    def last_upsert_json(self):
        for sql, params in reversed(self.calls):
            if "INSERT INTO app_settings" in sql:
                return json.loads(params[0])
        raise AssertionError("no app_settings upsert was executed")


def test_persists_live_edge_fields(monkeypatch):
    cap = _ExecuteCapture()
    monkeypatch.setattr(lsmr, "execute", cap)

    active = {
        "trained_at": "2026-07-26T05:37:36.071659", "cv_auc": 0.6207, "test_auc": 0.6408,
        "test_acc": 0.6080, "base_rate": 0.4238, "n_samples": 14569,
        "feature_names": list(range(44)),
    }
    lsmr._persist_live_edge_status(active, live_auc=0.4615, live_n=671257, live_edge_proven=False)

    payload = cap.last_upsert_json()
    assert payload["live_auc"] == 0.4615
    assert payload["live_auc_rows"] == 671257
    assert payload["live_edge_proven"] is False


def test_preserves_deployed_model_metrics_not_a_rejected_candidates(monkeypatch):
    """The reject-branch call site passes `baseline` (the still-deployed model's own metrics),
    not the rejected candidate's -- this pins that _persist_live_edge_status itself doesn't
    silently substitute whatever dict it's handed for something else, and that trained_at/
    cv_auc/test_auc genuinely come from the `active` argument, unchanged."""
    cap = _ExecuteCapture()
    monkeypatch.setattr(lsmr, "execute", cap)

    deployed_model = {
        "trained_at": "2026-07-26T05:37:36.071659", "cv_auc": 0.6207, "test_auc": 0.6408,
        "test_acc": 0.6080, "base_rate": 0.4238, "n_samples": 14569,
        "feature_names": list(range(44)),
    }
    lsmr._persist_live_edge_status(deployed_model, live_auc=0.4615, live_n=671257, live_edge_proven=False)

    payload = cap.last_upsert_json()
    assert payload["trained_at"] == "2026-07-26T05:37:36.071659"
    assert payload["test_auc"] == 0.6408
    assert payload["cv_auc"] == 0.6207
    assert payload["n_samples"] == 14569
    assert payload["n_features"] == 44


def test_no_active_model_is_a_safe_no_op(monkeypatch):
    """A None baseline (no model ever trained) must not crash or write a garbage row."""
    cap = _ExecuteCapture()
    monkeypatch.setattr(lsmr, "execute", cap)

    lsmr._persist_live_edge_status(None, live_auc=None, live_n=0, live_edge_proven=False)

    assert cap.calls == [], "must not write anything when there is no active model to describe"


def _synthetic_training_frame(n_dates=20, symbols_per_day=15):
    """Same shape as test_live_screener_ml_ranker_cv.py's builder -- reused rather than
    re-guessed, since _load_training_frame()'s real columns (symbol/filter_key/appeared_at/
    run_id/run_ts/return_intraday/change_per/volume) aren't obvious from train()'s signature
    alone. run_id was added 2026-08-07 when _build_matrix() moved from (appeared_at, symbol)
    to (run_id, symbol) grouping; run_ts the same day for the point-in-time reversal-feature
    join (live_screener_ml_no_live_edge_2026_08_07 memory)."""
    import numpy as np
    import pandas as pd
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


def test_train_refreshes_live_edge_status_even_when_candidate_is_rejected(monkeypatch, tmp_path):
    """Wiring check, not just the helper in isolation: train() must call
    _persist_live_edge_status on the REJECT path too, not only on promotion -- this is the
    actual bug (train() previously wrote app_settings only inside `if promote:`)."""
    monkeypatch.setattr(lsmr, "MODEL_PATH", str(tmp_path / "model.pkl"))
    monkeypatch.setattr(lsmr, "CANDIDATE_PATH", str(tmp_path / "model_candidate.pkl"))
    monkeypatch.setattr(lsmr, "_load_training_frame", lambda: _synthetic_training_frame())

    # An impossibly strong baseline (test_auc=0.999) so the synthetic candidate can never
    # clear the promotion margin -- deterministic REJECT path, matching
    # test_cs_ranker_promotion_gate.py's "impossibly high baseline" convention.
    monkeypatch.setattr(lsmr, "_load_active_metrics", lambda: {
        "trained_at": "2026-01-01T00:00:00", "cv_auc": 0.99, "test_auc": 0.999,
        "test_acc": 0.99, "base_rate": 0.5, "n_samples": 100, "feature_names": ["f0"],
    })

    calls = []
    monkeypatch.setattr(
        lsmr, "_persist_live_edge_status",
        lambda active, live_auc, live_n, live_edge_proven: calls.append(
            (active is not None, live_auc, live_n, live_edge_proven)))
    monkeypatch.setattr(lsmr, "_live_auc", lambda: (0.46, 671257))

    lsmr.train()

    assert len(calls) == 1, "_persist_live_edge_status must be called exactly once per train() run"
    active_was_not_none, live_auc, live_n, live_edge_proven = calls[0]
    assert active_was_not_none, "the reject path must pass the still-deployed model, not None"
    assert live_auc == 0.46
    assert live_n == 671257
