"""The unit suite must not write monitoring rows into production.

Found 2026-09-10 by running a new dl_engine test and watching it print
`[DRIFT] persisted held-out metrics for 2026-09-10`. `train_lstm()` calls
`drift_detector.write_training_metrics(metrics, model_version=f"lstm_v{version}")` on every
run, and `test_dl_engine.py::test_train_lstm_calls_walk_forward_validate` drives `train_lstm`
with `version=99` and a hardcoded sentinel `{"directional_accuracy": 0.55, "roc_auc": 0.58}`.
A developer's Postgres IS production here, so the sentinel landed in `dl_model_performance`.

Live before the fix: 10 rows with `model_version='lstm_v99'`, spanning 2026-08-27..2026-09-10,
holding exactly two distinct metric pairs -- `(0.55, 0.58)` (the sentinel) and `(None, None)`.

Worse than an extra row: the upsert key is `(model_name, eval_date, horizon_days)` and does
NOT include `model_version`, so one test run REPLACES that day's genuine row. `drift_detector`
then reads a unit-test constant as the DL model's held-out accuracy baseline.

Same class as the Telegram incident in recurring-bugs.md ("a test that can reach a network side
effect without a mock WILL, on some full-suite run, perform it against production"), and fixed
the same two ways: the callers mock it, AND the writer itself is inert under pytest so the next
unmocked test cannot re-pollute the table.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import drift_detector as dd


def test_write_training_metrics_does_not_touch_the_db_under_pytest(monkeypatch):
    calls = []
    monkeypatch.setattr(dd, "execute", lambda *a, **k: calls.append(a))

    dd.write_training_metrics({"directional_accuracy": 0.55, "roc_auc": 0.58},
                              model_version="lstm_v99")

    assert calls == [], (
        "write_training_metrics wrote to the database from inside the test suite -- that row "
        "lands in production and overwrites the day's real monitoring row"
    )


def test_the_guard_discriminates_rather_than_disabling_the_writer(monkeypatch):
    """A guard that never lets the write through would silently kill real monitoring. The
    escape hatch proves the write path is intact, not merely quiet."""
    calls = []
    monkeypatch.setattr(dd, "execute", lambda *a, **k: calls.append(a))
    monkeypatch.setenv("DRIFT_ALLOW_TEST_WRITES", "1")

    dd.write_training_metrics({"directional_accuracy": 0.55, "roc_auc": 0.58},
                              eval_date="2026-01-01", model_version="lstm_v99")

    assert len(calls) == 1, "the writer must still work when it is genuinely asked to"
