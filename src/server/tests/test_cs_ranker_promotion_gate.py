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
    def __init__(self, baseline_rho):
        self._baseline_rho = baseline_rho
        self.executed = []
        self._next_id = 1

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        if "SELECT cv_roc_auc" in self.executed[-1][0]:
            return None if self._baseline_rho is None else (self._baseline_rho,)
        if "RETURNING id" in self.executed[-1][0]:
            self._next_id += 1
            return (self._next_id,)
        return None


class _FakeConn:
    def __init__(self, baseline_rho):
        self.cur = _FakeCursor(baseline_rho)
        self.committed = 0

    def execute(self, sql, params=None):
        return self.cur.execute(sql, params)

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


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
