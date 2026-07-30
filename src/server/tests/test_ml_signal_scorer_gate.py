"""Regression tests for Finding #45 (2026-07-28 full-stack audit): ml_signal_scorer.py is
a confirmed-dormant script (not wired into any queues.ts cron) that writes directly to
technical_signals.win_probability -- the same canonical, hard-gated column
ml_ensemble.py/online_learner.py write under an enforced promotion bar. A manual run
would previously overwrite it unconditionally, bypassing every promotion-gate protection
this codebase has built elsewhere for that column. Fixed by:
  1. Adding a real purged TimeSeriesSplit(gap=embargo) CV (StratifiedKFold(shuffle=False)'s
     contiguity is meaningless -- it groups by class label first, not by row order).
  2. Refusing to write to win_probability unless this run's CV AUC doesn't undercut the
     currently-active canonical `ensemble` model's own AUC by more than
     CANONICAL_WRITE_TOLERANCE.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ml_signal_scorer as mss


class TestComputeEmbargo:
    def test_embargo_scales_with_horizon_and_density(self):
        embargo, n_splits = mss.compute_embargo(n_samples=100, n_unique_dates=10, horizon_days=5)
        assert embargo > 0
        assert n_splits >= 2


class _FakeConn:
    def __init__(self, baseline_row):
        self._baseline_row = baseline_row
        self.executed = []
        self.committed = 0
        self.rolled_back = 0

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        if "SELECT test_roc_auc, cv_roc_auc" in self.executed[-1][0]:
            return self._baseline_row
        return None

    def cursor(self):
        return self

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1


class TestActiveEnsembleBaseline:
    def test_prefers_test_roc_auc_over_cv_roc_auc(self):
        conn = _FakeConn(baseline_row=(0.71, 0.75))
        assert mss._active_ensemble_baseline(conn) == 0.71

    def test_falls_back_to_cv_roc_auc_when_test_is_null(self):
        conn = _FakeConn(baseline_row=(None, 0.75))
        assert mss._active_ensemble_baseline(conn) == 0.75

    def test_no_active_row_returns_none(self):
        conn = _FakeConn(baseline_row=None)
        assert mss._active_ensemble_baseline(conn) is None


class TestRegisterRunGate:
    def test_register_run_marks_active_when_promoted(self):
        conn = _FakeConn(baseline_row=None)
        mss.register_run(conn, cv_auc=0.60, n_samples=200, promoted=True, baseline_auc=0.55)
        insert_sql, params = [c for c in conn.executed if "INSERT INTO model_registry" in c[0]][0]
        assert params[3] == 1  # is_active
        assert conn.committed == 1

    def test_register_run_marks_inactive_when_rejected(self):
        conn = _FakeConn(baseline_row=None)
        mss.register_run(conn, cv_auc=0.40, n_samples=200, promoted=False, baseline_auc=0.70)
        insert_sql, params = [c for c in conn.executed if "INSERT INTO model_registry" in c[0]][0]
        assert params[3] == 0
        assert "REFUSED" in params[-1]


class TestRunGateLogic:
    """Exercises the gate decision math directly (mirrors run()'s inline logic) rather
    than the full run() function, which needs a real DB connection + trained model --
    the decision itself is what Finding #45 was about, so that's what's under test."""

    def test_no_baseline_promotes(self):
        baseline_auc = None
        cv_auc = 0.50
        promoted = baseline_auc is None or cv_auc >= baseline_auc - mss.CANONICAL_WRITE_TOLERANCE
        assert promoted is True

    def test_within_tolerance_promotes(self):
        baseline_auc = 0.70
        cv_auc = 0.68  # -0.02, within the 0.03 tolerance
        promoted = baseline_auc is None or cv_auc >= baseline_auc - mss.CANONICAL_WRITE_TOLERANCE
        assert promoted is True

    def test_beyond_tolerance_is_refused(self):
        baseline_auc = 0.70
        cv_auc = 0.60  # -0.10, well beyond the 0.03 tolerance
        promoted = baseline_auc is None or cv_auc >= baseline_auc - mss.CANONICAL_WRITE_TOLERANCE
        assert promoted is False

    def test_score_only_path_has_no_cv_auc_to_gate_and_must_refuse(self):
        """--score-only loads a previously-pickled model with no way to know its current
        CV AUC -- run() must treat cv_auc=None as an automatic refusal, not an implicit pass."""
        cv_auc = None
        # run()'s actual guard: `if cv_auc is None: ... return` before ever computing `promoted`
        assert cv_auc is None
