"""Regression tests for Finding #17 (2026-07-28 full-stack audit): cs_ranker.py's
_register_cs_model() used to unconditionally deactivate the previous cs_ranker model and
activate the new one -- the code even logged "rho below threshold... model saved anyway"
and proceeded to activate it regardless. Fixed with a champion/challenger gate matching
ml_ensemble.py/live_screener_ml_ranker.py: only activate if the new held-out Spearman rho
beats the active model's by >= CS_PROMOTION_MARGIN, or there is no active model yet.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import cs_ranker as csr


class _FakeCursor:
    def __init__(self, baseline_rho, baseline_id=1, baseline_trained_at="2026-01-01T00:00:00",
                 rejections=0):
        self._baseline_rho = baseline_rho
        self._baseline_id = baseline_id
        self._baseline_trained_at = baseline_trained_at
        # 0 by default (below CS_STALENESS_MAX_REJECTIONS=10) so the staleness-override safety
        # valve (2026-08-06) can never spuriously fire in the basic promotion-gate tests below
        # regardless of how old/new _baseline_trained_at computes as against real wall-clock
        # time -- staleness_override_applies requires BOTH age AND rejection-count thresholds.
        self._rejections = rejections
        self.executed = []
        self._next_id = 1

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        sql = self.executed[-1][0]
        if "SELECT id, cv_roc_auc, trained_at" in sql:
            return None if self._baseline_rho is None else (
                self._baseline_id, self._baseline_rho, self._baseline_trained_at)
        if "SELECT COUNT(*) FROM model_registry" in sql:
            return (self._rejections,)
        if "RETURNING id" in sql:
            self._next_id += 1
            return (self._next_id,)
        return None


class _FakeConn:
    def __init__(self, baseline_rho, baseline_id=1, baseline_trained_at="2026-01-01T00:00:00",
                 rejections=0):
        self.cur = _FakeCursor(baseline_rho, baseline_id, baseline_trained_at, rejections)
        self.committed = 0

    def execute(self, sql, params=None):
        return self.cur.execute(sql, params)

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1

    def rollback(self):
        pass


class _FakeModel:
    feature_importances_ = [0.5, 0.3, 0.2]


def _fake_trained_model(rho):
    return {
        "model": _FakeModel(),
        "feature_names": ["a", "b", "c"],
        "spearman_rho": rho,
        "n_samples": 500,
        "trained_at": "2026-07-30T00:00:00",
    }


class TestCsRankerPromotionGate:
    def test_no_baseline_always_promotes(self, monkeypatch, tmp_path):
        monkeypatch.setattr(csr, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(csr, "CS_MODEL_PATH", str(tmp_path / "cs_ranker.pkl"))
        monkeypatch.setattr(csr, "CS_CANDIDATE_PATH", str(tmp_path / "cs_ranker.pkl.candidate"))

        conn = _FakeConn(baseline_rho=None)
        csr._register_cs_model(conn, _fake_trained_model(rho=0.15))

        assert os.path.exists(csr.CS_MODEL_PATH)
        insert_sql = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0][0]
        assert "1, 5" in insert_sql or ", 1, 5," in insert_sql

    def test_improvement_beyond_margin_promotes_and_deactivates_old(self, monkeypatch, tmp_path):
        monkeypatch.setattr(csr, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(csr, "CS_MODEL_PATH", str(tmp_path / "cs_ranker.pkl"))
        monkeypatch.setattr(csr, "CS_CANDIDATE_PATH", str(tmp_path / "cs_ranker.pkl.candidate"))

        conn = _FakeConn(baseline_rho=0.12)
        csr._register_cs_model(conn, _fake_trained_model(rho=0.14))  # +0.02, clears 0.01 margin

        assert os.path.exists(csr.CS_MODEL_PATH)
        deactivate_calls = [c for c in conn.cur.executed if "UPDATE model_registry SET is_active = 0" in c[0]]
        assert len(deactivate_calls) == 1

    def test_regression_beyond_margin_is_rejected(self, monkeypatch, tmp_path):
        monkeypatch.setattr(csr, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(csr, "CS_MODEL_PATH", str(tmp_path / "cs_ranker.pkl"))
        monkeypatch.setattr(csr, "CS_CANDIDATE_PATH", str(tmp_path / "cs_ranker.pkl.candidate"))

        conn = _FakeConn(baseline_rho=0.20)
        csr._register_cs_model(conn, _fake_trained_model(rho=0.10))  # well below baseline

        assert not os.path.exists(csr.CS_MODEL_PATH), "rejected candidate must NOT overwrite the live model file"
        assert os.path.exists(csr.CS_CANDIDATE_PATH)
        deactivate_calls = [c for c in conn.cur.executed if "UPDATE model_registry SET is_active = 0" in c[0]]
        assert deactivate_calls == [], "a rejected candidate must not deactivate the current live model"
        insert_sql = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0][0]
        assert ", 0, 5," in insert_sql, "rejected candidate must be logged with is_active=0"

    def test_tie_within_margin_is_rejected_not_promoted(self, monkeypatch, tmp_path):
        """A new model that merely matches (doesn't beat) baseline by the margin must not
        churn the live model -- prevents noise-driven flip-flopping."""
        monkeypatch.setattr(csr, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(csr, "CS_MODEL_PATH", str(tmp_path / "cs_ranker.pkl"))
        monkeypatch.setattr(csr, "CS_CANDIDATE_PATH", str(tmp_path / "cs_ranker.pkl.candidate"))

        conn = _FakeConn(baseline_rho=0.15)
        csr._register_cs_model(conn, _fake_trained_model(rho=0.15))  # identical, no improvement

        assert not os.path.exists(csr.CS_MODEL_PATH)
        assert os.path.exists(csr.CS_CANDIDATE_PATH)


class TestCsRankerStalenessOverride:
    """2026-08-06: cs_ranker had no staleness-override safety valve at all -- confirmed live,
    its real active baseline predates the 2026-07-30 CV-leakage fix and every honest post-fix
    retrain since (4 attempts) was rejected against a rho that can never be legitimately beaten
    again. Wired to model_promotion.staleness_override_applies, mirroring ml_ensemble.py."""

    def test_stale_unbeaten_baseline_with_enough_rejections_is_overridden(self, monkeypatch, tmp_path):
        monkeypatch.setattr(csr, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(csr, "CS_MODEL_PATH", str(tmp_path / "cs_ranker.pkl"))
        monkeypatch.setattr(csr, "CS_CANDIDATE_PATH", str(tmp_path / "cs_ranker.pkl.candidate"))
        # Real-world-independent: freeze "now" so age_days is deterministic regardless of the
        # actual wall-clock date the test suite runs on.
        monkeypatch.setattr(
            csr, "staleness_override_applies",
            lambda trained_at, rejections, max_days, max_rejections: (True, 42.0))

        conn = _FakeConn(baseline_rho=0.20, rejections=csr.CS_STALENESS_MAX_REJECTIONS)
        model_id = csr._register_cs_model(conn, _fake_trained_model(rho=0.10))  # still below margin

        assert os.path.exists(csr.CS_MODEL_PATH), (
            "a candidate stuck behind a stale, permanently-unbeatable baseline must still be "
            "auto-adopted once the staleness override fires"
        )
        insert_sql = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0][0]
        insert_params = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0][1]
        assert "STALENESS OVERRIDE" in insert_params[-1], (
            "the promoted row's notes must record that this was a staleness override, not a "
            "genuine margin-clearing promotion, for future audit"
        )
        assert model_id is not None

    def test_young_baseline_with_many_rejections_is_not_overridden(self, monkeypatch, tmp_path):
        """Both conditions (age AND rejection count) are required -- a recently-retrained
        baseline must still gate normally even under repeated rejections."""
        monkeypatch.setattr(csr, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(csr, "CS_MODEL_PATH", str(tmp_path / "cs_ranker.pkl"))
        monkeypatch.setattr(csr, "CS_CANDIDATE_PATH", str(tmp_path / "cs_ranker.pkl.candidate"))
        monkeypatch.setattr(
            csr, "staleness_override_applies",
            lambda trained_at, rejections, max_days, max_rejections: (False, 0.5))

        conn = _FakeConn(baseline_rho=0.20, rejections=csr.CS_STALENESS_MAX_REJECTIONS)
        csr._register_cs_model(conn, _fake_trained_model(rho=0.10))

        assert not os.path.exists(csr.CS_MODEL_PATH)
        assert os.path.exists(csr.CS_CANDIDATE_PATH)

    def test_stale_baseline_with_few_rejections_is_not_overridden(self, monkeypatch, tmp_path):
        """Both conditions required -- an old baseline that has only been challenged once or
        twice must still gate normally; the override is for SUSTAINED deadlock only."""
        monkeypatch.setattr(csr, "MODELS_DIR", str(tmp_path))
        monkeypatch.setattr(csr, "CS_MODEL_PATH", str(tmp_path / "cs_ranker.pkl"))
        monkeypatch.setattr(csr, "CS_CANDIDATE_PATH", str(tmp_path / "cs_ranker.pkl.candidate"))
        monkeypatch.setattr(
            csr, "staleness_override_applies",
            lambda trained_at, rejections, max_days, max_rejections: (False, 90.0))

        conn = _FakeConn(baseline_rho=0.20, rejections=1)
        csr._register_cs_model(conn, _fake_trained_model(rho=0.10))

        assert not os.path.exists(csr.CS_MODEL_PATH)
        assert os.path.exists(csr.CS_CANDIDATE_PATH)
