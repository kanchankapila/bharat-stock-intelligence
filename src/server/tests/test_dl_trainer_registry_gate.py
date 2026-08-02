"""Regression tests for a live incident (2026-08-01/02): dl_trainer.py's retrain_models()
reimplemented its own quality gate instead of calling dl_engine.py's already-correct
_promote_lstm_version(). That gate treated NaN acc/roc_auc as "insufficient data — skip the
check, promote anyway", which is backwards: train_lstm() sets metrics["error"] specifically
when the WEIGHTS diverged and correctly refuses to even torch.save() the checkpoint, but this
gate never looked at that key. Result observed live: dl_model_config.json pointed at
lstm_v19.pt, a file that was never written, and run_inference() silently produced zero
predictions every day while reporting success. Every version from v4 through v18 was also
left with is_active=1 in model_registry forever, since the old code never deactivated the
previous row either way (checked live: 17 of 18 BiLSTM rows were simultaneously "active").

Fixed by (1) routing the gate decision through _promote_lstm_version() (already covered by
test_dl_engine_promotion_gate.py) and (2) extracting the model_registry bookkeeping into
_record_model_registry(), tested here in isolation — mirrors cs_ranker.py's
_register_cs_model / test_cs_ranker_promotion_gate.py pattern exactly, since this is the same
bug class (Finding #17: unconditional promotion, never-deactivated prior row).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dl_trainer as dlt


class _FakeCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        return None


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()
        self.committed = 0

    def execute(self, sql, params=None):
        return self.cur.execute(sql, params)

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


class TestRecordModelRegistry:
    def test_promoted_deactivates_prior_row_and_marks_new_one_active(self):
        conn = _FakeConn()
        dlt._record_model_registry(conn, new_version=4, auc=0.60, acc=0.55, promoted=True)

        deactivate_calls = [c for c in conn.cur.executed if "UPDATE model_registry SET is_active=0" in c[0]]
        assert len(deactivate_calls) == 1, "a promoted version must deactivate the prior active row"

        insert_calls = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]]
        assert len(insert_calls) == 1
        params = insert_calls[0][1]
        assert params == ("BiLSTM", "4", "deep_learning", 0.60, 0.55, -1, 1)
        assert conn.committed == 1

    def test_not_promoted_never_deactivates_and_logs_inactive(self):
        """The core regression: a diverged/rejected version (e.g. metrics carrying
        train_lstm()'s "error" key, or a NaN roc_auc that _promote_lstm_version refused)
        must NOT touch the previously-active row, and must be logged with is_active=0 --
        not left to default to whatever the old unconditional-promote gate decided."""
        conn = _FakeConn()
        dlt._record_model_registry(conn, new_version=19, auc=float("nan"), acc=float("nan"), promoted=False)

        deactivate_calls = [c for c in conn.cur.executed if "UPDATE model_registry SET is_active=0" in c[0]]
        assert deactivate_calls == [], "a rejected/diverged candidate must not deactivate the live model"

        insert_calls = [c for c in conn.cur.executed if "INSERT INTO model_registry" in c[0]]
        assert len(insert_calls) == 1
        params = insert_calls[0][1]
        assert params[-1] == 0, "a rejected candidate must be logged with is_active=0, never 1"

    def test_deactivate_scoped_to_bilstm_only(self):
        """The UPDATE must filter on model_name='BiLSTM' -- this table is shared with
        ml_ensemble/cs_ranker/live_screener_ml_ranker's own rows, which must be untouched."""
        conn = _FakeConn()
        dlt._record_model_registry(conn, new_version=2, auc=0.55, acc=0.50, promoted=True)

        deactivate_call = [c for c in conn.cur.executed if "UPDATE model_registry SET is_active=0" in c[0]][0]
        sql, params = deactivate_call
        assert params == ("BiLSTM",)
        assert "model_name=?" in sql


class TestStaleLockThreshold:
    def test_exceeds_the_bullmq_job_timeout(self):
        """queues.ts sets dl-retrain-weekly/emergency's BullMQ timeout to 24h (measured: a
        25-symbol sample took ~15min under typical GPU contention, so a full ~2100-symbol
        run can legitimately take many hours). This threshold must stay above that, or a
        real in-progress run gets treated as a stale lock and a second trainer starts
        concurrently -- both writing lstm_v{N}.pt / dl_model_config.json at once."""
        assert dlt.STALE_LOCK_SECONDS > 24 * 60 * 60


class TestRetrainModelsGateWiring:
    """retrain_models() must consult dl_engine's real gate, not decide promotion itself
    from acc/auc NaN-ness. This doesn't re-test _promote_lstm_version's own logic (covered
    by test_dl_engine_promotion_gate.py) -- it confirms retrain_models() actually calls it
    and doesn't silently promote a NaN/errored result on its own."""

    def test_module_no_longer_defines_dead_quality_thresholds(self):
        # QUALITY_MIN_ACC/QUALITY_MIN_AUC were the old gate's thresholds; the gate that used
        # them is gone, so these must not still exist as unused, misleading module constants.
        assert not hasattr(dlt, "QUALITY_MIN_ACC")
        assert not hasattr(dlt, "QUALITY_MIN_AUC")

    def test_source_calls_promote_lstm_version(self):
        import inspect
        src = inspect.getsource(dlt.retrain_models)
        assert "_promote_lstm_version" in src, (
            "retrain_models() must delegate the promotion decision to dl_engine's gate, "
            "not reimplement its own acc/auc NaN check"
        )
        assert "_record_model_registry" in src
