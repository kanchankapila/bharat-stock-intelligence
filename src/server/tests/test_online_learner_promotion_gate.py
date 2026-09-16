"""Regression tests for Finding #17 (2026-07-28 full-stack audit): online_learner.py's
register_update() used to insert every incremental SGD update as is_active=1 with no
comparison to pre-update state and no deactivation of prior rows -- model_registry could
accumulate multiple 'active' online_sgd rows, and a regressed update was indistinguishable
from a good one to anything reading is_active. Fixed by deactivating the previous active
row and only marking the new one active if cv_auc didn't regress beyond
ONLINE_REGRESSION_TOLERANCE versus it.

Extended 2026-08-15: partial_fit mutates the live SGD state in place with no undo, but that
only means register_update() itself can't roll back the in-memory model -- the ON-DISK file
is a separate question. register_update() now returns whether it marked the update active,
and run() uses that to decide whether to persist the post-update state to disk or revert to
its own pre-update snapshot (see TestRegisterUpdateReturnValue below).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import online_learner as ol


class _FakeCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        return None


class _FakeConn:
    def __init__(self, baseline_auc):
        self._baseline_auc = baseline_auc
        self.cur = _FakeCursor()
        self.committed = 0

    def execute(self, sql, params=None):
        self.cur.executed.append((sql, params))
        return self

    def fetchone(self):
        if self._baseline_auc is None:
            return None
        return (self._baseline_auc,)

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


def _fake_state():
    return {"last_updated": "2026-07-30T00:00:00", "n_samples_seen": 5000}


class TestOnlineLearnerPromotionGate:
    def test_no_baseline_is_marked_active(self):
        conn = _FakeConn(baseline_auc=None)
        ol.register_update(conn, _fake_state(), n_new=50, cv_auc=0.65)
        insert_sql, insert_params = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0]
        assert insert_params[4] == 1, "is_active must be 1 when there is no prior active row"

    def test_improvement_is_marked_active_and_deactivates_prior_row(self):
        conn = _FakeConn(baseline_auc=0.60)
        ol.register_update(conn, _fake_state(), n_new=50, cv_auc=0.65)
        deactivate_calls = [c for c in conn.cur.executed if "UPDATE model_registry SET is_active = 0" in c[0]]
        assert len(deactivate_calls) == 1
        insert_sql, insert_params = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0]
        assert insert_params[4] == 1

    def test_small_dip_within_tolerance_still_marked_active(self):
        conn = _FakeConn(baseline_auc=0.65)
        ol.register_update(conn, _fake_state(), n_new=50, cv_auc=0.64)  # -0.01, within 0.02 tolerance
        insert_sql, insert_params = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0]
        assert insert_params[4] == 1

    def test_regression_beyond_tolerance_is_logged_but_not_active(self):
        conn = _FakeConn(baseline_auc=0.65)
        ol.register_update(conn, _fake_state(), n_new=50, cv_auc=0.55)  # -0.10, well beyond tolerance
        insert_sql, insert_params = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]][0]
        assert insert_params[4] == 0, "a regressed update must be logged with is_active=0"
        assert "REGRESSED" in insert_params[-1]
        # the prior active row must still be deactivated even though the new one isn't active --
        # otherwise the (now-stale) old row would remain the sole "active" row forever
        deactivate_calls = [c for c in conn.cur.executed if "UPDATE model_registry SET is_active = 0" in c[0]]
        assert len(deactivate_calls) == 1

    def test_every_call_commits(self):
        conn = _FakeConn(baseline_auc=None)
        ol.register_update(conn, _fake_state(), n_new=50, cv_auc=0.65)
        assert conn.committed == 1


class TestRegisterUpdateReturnValue:
    """run() decides whether to persist the mutated (post-partial_fit) SGD state to disk or
    revert to its own pre-update snapshot based on this return value -- if it silently went
    back to returning None, run()'s `state if is_active else pre_update_state` would always
    take the pre-update branch (None is falsy), permanently freezing the on-disk model."""

    def test_returns_true_when_marked_active(self):
        conn = _FakeConn(baseline_auc=0.60)
        result = ol.register_update(conn, _fake_state(), n_new=50, cv_auc=0.65)
        assert result is True

    def test_returns_false_when_regressed_beyond_tolerance(self):
        conn = _FakeConn(baseline_auc=0.65)
        result = ol.register_update(conn, _fake_state(), n_new=50, cv_auc=0.55)
        assert result is False
