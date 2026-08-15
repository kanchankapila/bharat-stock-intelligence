"""
Tests for exit_policy — MFE/MAE regressors and level translation.
suggest_levels is pure; train_from_df / predict_levels run on synthetic data (no DB).
"""

import datetime
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from exit_policy import suggest_levels, train_from_df, predict_levels
import exit_policy as ep


class TestSuggestLevels:
    def test_capture_and_buffer_math(self):
        target, stop = suggest_levels(100.0, pred_mfe_pct=10.0, pred_mae_pct=-5.0,
                                      mfe_capture=0.6, mae_buffer=1.15)
        assert target == pytest.approx(106.0)     # 100 × (1 + 10×0.6/100)
        assert stop == pytest.approx(94.25)        # 100 × (1 + (-5×1.15)/100)

    def test_long_ordering_target_above_entry_above_stop(self):
        target, stop = suggest_levels(250.0, pred_mfe_pct=8.0, pred_mae_pct=-4.0)
        assert target > 250.0 > stop


def _synthetic(n=80, seed=0):
    rng = np.random.default_rng(seed)
    score = rng.integers(1, 11, n).astype(float)
    return pd.DataFrame({
        "symbol": [f"S{i%10}" for i in range(n)],
        "signal_date": pd.bdate_range("2024-01-01", periods=n).strftime("%Y-%m-%d"),
        "signal_score": score,
        "signals_json": ["[]"] * n,
        # MFE grows with score, MAE shrinks (more negative) with weaker scores — learnable.
        "mfe_pct": 5 + 0.8 * score + rng.normal(0, 0.5, n),
        "mae_pct": -(6 - 0.4 * score) + rng.normal(0, 0.3, n),
        # train_from_df's purge-embargo split (added to close a look-ahead leak — see
        # docs/superpowers commit 66023a5) reads horizon_days directly off the df; this
        # fixture predates that change. 15 matches the codebase's typical default horizon.
        "horizon_days": 15,
    })


class TestTrainAndPredict:
    def test_insufficient_data_returns_none(self):
        assert train_from_df(_synthetic(10), min_samples=50) is None

    def test_trains_and_persists_both_heads(self):
        payload = train_from_df(_synthetic(80), min_samples=20)
        assert payload is not None
        assert "mfe_model" in payload and "mae_model" in payload
        assert payload["feature_names"]
        assert payload["n_samples"] == 80
        assert np.isfinite(payload["metrics"]["mfe_holdout_mae"])

    def test_predict_levels_returns_sane_long_bracket(self):
        payload = train_from_df(_synthetic(80), min_samples=20)
        row = _synthetic(1, seed=3).iloc[[0]]
        target, stop = predict_levels(row, entry=100.0, model=payload)
        assert target > 100.0 > stop          # predicted MFE>0, MAE<0 → bracket straddles entry


class TestMixedHorizonEmbargo:
    """Live bug, 2026-08-09: horizon_days = max(df['horizon_days']) let a small minority of
    long-horizon rows (e.g. 0.8% at horizon=30 in production) force an embargo so large it
    pushed embargo_end_date past every remaining date -- test_mask was empty EVERY run this
    shape occurred, and the model was saved anyway with a NaN holdout MAE and no error. Fixed
    to use the median horizon, which a small minority can't dominate."""

    @staticmethod
    def _mixed_horizon(n=200, seed=0, minority_frac=0.02):
        rng = np.random.default_rng(seed)
        score = rng.integers(1, 11, n).astype(float)
        dates = pd.bdate_range("2024-01-01", periods=n)
        # Dominant horizon=5 for all but the last `minority_frac` rows, which get horizon=60 --
        # mirrors production's 0.8%-at-horizon=30 shape closely enough to reproduce the bug.
        horizons = np.full(n, 5)
        n_minority = max(1, int(n * minority_frac))
        horizons[-n_minority:] = 60
        return pd.DataFrame({
            "symbol": [f"S{i%10}" for i in range(n)],
            "signal_date": dates.strftime("%Y-%m-%d"),
            "signal_score": score,
            "signals_json": ["[]"] * n,
            "mfe_pct": 5 + 0.8 * score + rng.normal(0, 0.5, n),
            "mae_pct": -(6 - 0.4 * score) + rng.normal(0, 0.3, n),
            "horizon_days": horizons,
        })

    def test_minority_long_horizon_does_not_empty_the_holdout(self):
        payload = train_from_df(self._mixed_horizon(), min_samples=20)
        assert payload is not None
        assert np.isfinite(payload["metrics"]["mfe_holdout_mae"]), (
            "a 2% minority of long-horizon rows must not force an empty (NaN) holdout"
        )
        assert np.isfinite(payload["metrics"]["mae_holdout_mae"])

    def test_fixture_genuinely_reproduces_the_old_bug_mechanism(self):
        """Negative control, without monkeypatching pandas internals: proves the fixture's
        minority-horizon shape genuinely would have emptied the holdout under the OLD
        max()-based embargo, so test_minority_long_horizon_does_not_empty_the_holdout above
        is verified against a real failure mode, not a fixture that happened to pass either
        way regardless of which statistic is used."""
        df = self._mixed_horizon()
        dates = pd.to_datetime(df["signal_date"])
        cut = max(20 // 2, int(len(df) * 0.8))
        train_end_date = dates.iloc[min(cut, len(df) - 1)]

        old_horizon = int(pd.to_numeric(df["horizon_days"]).max())       # the old, buggy statistic
        new_horizon = int(pd.to_numeric(df["horizon_days"]).median())    # the fixed statistic

        old_test_mask = (dates > train_end_date + pd.Timedelta(days=old_horizon)).values
        new_test_mask = (dates > train_end_date + pd.Timedelta(days=new_horizon)).values

        assert not old_test_mask.any(), (
            "fixture should reproduce the empty holdout under the OLD max()-based embargo"
        )
        assert new_test_mask.any(), (
            "fixture should NOT be empty under the fixed median()-based embargo"
        )


class _FakeExitCursor:
    def __init__(self, baseline=None, rejections=0, trained_at=None):
        self._baseline = baseline  # (mfe_mae, mae_mae) tuple or None
        self._rejections = rejections
        # Defaults to now() so staleness_override_applies() reads age_days~=0 and never fires
        # unless a test explicitly overrides it (see TestExitPolicyStalenessOverride below) --
        # existing tests above this class predate the staleness override and must see
        # identical promote/reject behavior to before it was added.
        self._trained_at = trained_at or datetime.datetime.now().isoformat()
        self.executed = []
        self._next_id = 100

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        sql = self.executed[-1][0]
        if "SELECT id, cv_roc_auc, cv_accuracy, trained_at" in sql:
            if self._baseline is None:
                return None
            mfe_mae, mae_mae = self._baseline
            return (1, mfe_mae, mae_mae, self._trained_at)
        if "SELECT COUNT(*) FROM model_registry" in sql:
            return (self._rejections,)
        if "RETURNING id" in sql:
            self._next_id += 1
            return (self._next_id,)
        return None


class _FakeExitConn:
    def __init__(self, baseline=None, rejections=0, trained_at=None):
        self.cur = _FakeExitCursor(baseline, rejections, trained_at)
        self.committed = 0

    def execute(self, sql, params=None):
        return self.cur.execute(sql, params)

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


def _fake_exit_payload(mfe_mae, mae_mae):
    return {
        "mfe_model": object(), "mae_model": object(),
        "feature_names": ["a", "b"],
        "metrics": {"mfe_holdout_mae": mfe_mae, "mae_holdout_mae": mae_mae},
        "n_samples": 1000,
        "trained_at": "2026-08-09T00:00:00",
    }


class TestExitPolicyPromotionGate:
    """2026-08-09 audit: exit_policy.py had NO promotion gate at all -- train_from_df() used
    to unconditionally overwrite the live pickle regardless of holdout quality, including a
    NaN holdout MAE (see TestMixedHorizonEmbargo above)."""

    def test_no_baseline_bootstraps(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ep, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(ep, "EXIT_MODEL_PATH", str(tmp_path / "exit_policy.pkl"))
        monkeypatch.setattr(ep, "EXIT_CANDIDATE_PATH", str(tmp_path / "exit_policy.pkl.candidate"))

        conn = _FakeExitConn(baseline=None)
        ep._register_exit_model(conn, _fake_exit_payload(3.0, 2.0))

        assert os.path.exists(ep.EXIT_MODEL_PATH)

    def test_nan_holdout_mae_is_refused(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ep, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(ep, "EXIT_MODEL_PATH", str(tmp_path / "exit_policy.pkl"))
        monkeypatch.setattr(ep, "EXIT_CANDIDATE_PATH", str(tmp_path / "exit_policy.pkl.candidate"))

        conn = _FakeExitConn(baseline=None)  # even bootstrap must refuse a NaN candidate
        ep._register_exit_model(conn, _fake_exit_payload(float("nan"), 2.0))

        assert not os.path.exists(ep.EXIT_MODEL_PATH), (
            "a NaN holdout MAE (e.g. from an empty holdout) must never be promoted, "
            "even with no prior baseline to compare against"
        )
        assert os.path.exists(ep.EXIT_CANDIDATE_PATH)

    def test_both_metrics_must_improve_to_promote(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ep, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(ep, "EXIT_MODEL_PATH", str(tmp_path / "exit_policy.pkl"))
        monkeypatch.setattr(ep, "EXIT_CANDIDATE_PATH", str(tmp_path / "exit_policy.pkl.candidate"))

        # baseline mfe_mae=3.0, mae_mae=2.0. Candidate improves mfe (2.5) but WORSENS mae (2.5).
        conn = _FakeExitConn(baseline=(3.0, 2.0))
        ep._register_exit_model(conn, _fake_exit_payload(2.5, 2.5))

        assert not os.path.exists(ep.EXIT_MODEL_PATH), (
            "one combined pickle holds both regressors -- a partial improvement must not "
            "promote and silently regress the OTHER half"
        )
        assert os.path.exists(ep.EXIT_CANDIDATE_PATH)

    def test_both_metrics_improving_beyond_margin_promotes(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ep, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(ep, "EXIT_MODEL_PATH", str(tmp_path / "exit_policy.pkl"))
        monkeypatch.setattr(ep, "EXIT_CANDIDATE_PATH", str(tmp_path / "exit_policy.pkl.candidate"))

        conn = _FakeExitConn(baseline=(3.0, 2.0))
        ep._register_exit_model(conn, _fake_exit_payload(2.5, 1.5))  # both improve by 0.5

        assert os.path.exists(ep.EXIT_MODEL_PATH)
        deactivate_calls = [c for c in conn.cur.executed
                             if "UPDATE model_registry SET is_active = 0" in c[0]]
        assert len(deactivate_calls) == 1


class TestExitPolicyStalenessOverride:
    """ml-promotion-gate-review, 2026-08-14: exit_policy.py had no equivalent to
    ml_ensemble.py/cs_ranker.py/confluence_ml_engine.py's safety valve against a baseline
    whose holdout MAE became permanently unbeatable -- added 2026-08-15, same mechanism,
    reused directly since this baseline already lives in model_registry."""

    def _stale_trained_at(self, days_ago=10):
        return (datetime.datetime.now() - datetime.timedelta(days=days_ago)).isoformat()

    def test_stale_and_repeatedly_rejected_baseline_gets_overridden(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ep, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(ep, "EXIT_MODEL_PATH", str(tmp_path / "exit_policy.pkl"))
        monkeypatch.setattr(ep, "EXIT_CANDIDATE_PATH", str(tmp_path / "exit_policy.pkl.candidate"))

        # Candidate does NOT beat the baseline (mfe worsens 3.0->3.2), but the baseline has
        # gone unbeaten 10 days across 12 rejected candidates -- both conditions clear.
        conn = _FakeExitConn(baseline=(3.0, 2.0), rejections=12, trained_at=self._stale_trained_at(10))
        ep._register_exit_model(conn, _fake_exit_payload(3.2, 2.5))

        assert os.path.exists(ep.EXIT_MODEL_PATH), (
            "a candidate that doesn't clear the bar must still be promoted once the baseline "
            "is stale enough AND has been rejected against enough times"
        )

    def test_stale_but_not_enough_rejections_still_rejects(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ep, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(ep, "EXIT_MODEL_PATH", str(tmp_path / "exit_policy.pkl"))
        monkeypatch.setattr(ep, "EXIT_CANDIDATE_PATH", str(tmp_path / "exit_policy.pkl.candidate"))

        conn = _FakeExitConn(baseline=(3.0, 2.0), rejections=1, trained_at=self._stale_trained_at(10))
        ep._register_exit_model(conn, _fake_exit_payload(3.2, 2.5))

        assert not os.path.exists(ep.EXIT_MODEL_PATH), (
            "staleness alone must not override -- both age AND rejection count are required"
        )
        assert os.path.exists(ep.EXIT_CANDIDATE_PATH)

    def test_many_rejections_but_not_stale_still_rejects(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ep, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(ep, "EXIT_MODEL_PATH", str(tmp_path / "exit_policy.pkl"))
        monkeypatch.setattr(ep, "EXIT_CANDIDATE_PATH", str(tmp_path / "exit_policy.pkl.candidate"))

        conn = _FakeExitConn(baseline=(3.0, 2.0), rejections=50, trained_at=self._stale_trained_at(0.1))
        ep._register_exit_model(conn, _fake_exit_payload(3.2, 2.5))

        assert not os.path.exists(ep.EXIT_MODEL_PATH), (
            "rejection count alone must not override -- both age AND rejection count are required"
        )
        assert os.path.exists(ep.EXIT_CANDIDATE_PATH)
