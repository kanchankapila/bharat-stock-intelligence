"""AF-20260930-01: a unit test once wrote the sentinel metrics roc_auc=0.58 / directional_accuracy=0.55
into dl_model_performance; the drift upsert later relabelled those rows 'current', so a cleanup keyed on
the label missed them and the API served fake history. The repair selects by the polluted VALUE."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
import data_integrity_repair as dir_  # noqa: E402


def _db():
    c = pg_memory_conn()
    c.execute("CREATE TABLE dl_model_performance (id INTEGER PRIMARY KEY, model_version TEXT, "
              "eval_date TEXT, roc_auc REAL, directional_accuracy REAL, drift_score REAL)")
    c.executemany("INSERT INTO dl_model_performance VALUES (?,?,?,?,?,?)", [
        (1, 'current', '2026-08-24', 0.58, 0.55, 0.1),    # sentinel, relabelled 'current'
        (2, 'lstm_v99', '2026-08-25', 0.58, 0.55, 0.2),   # sentinel under its original label
        (3, 'current', '2026-09-20', 0.5208, 0.511, 0.3),  # genuine
        (4, 'current', '2026-09-21', 0.58, 0.60, 0.4),    # genuine: only roc_auc matches the sentinel
        (5, 'current', '2026-09-22', None, None, 0.5),    # already NULL
    ])
    c.commit()
    return c


def _rows(c):
    return {r[0]: (r[1], r[2]) for r in
            c.execute("SELECT id, roc_auc, directional_accuracy FROM dl_model_performance").fetchall()}


def test_nulls_sentinel_pairs_by_value_whatever_their_label():
    c = _db()
    dir_.repair_dl_performance_sentinels(c, dry=False)
    rows = _rows(c)
    assert rows[1] == (None, None) and rows[2] == (None, None)


def test_leaves_genuine_rows_alone():
    c = _db()
    dir_.repair_dl_performance_sentinels(c, dry=False)
    rows = _rows(c)
    assert rows[3] == (0.5208, 0.511)
    assert rows[4] == (0.58, 0.60)       # a coincidental 0.58 on its own is not the sentinel pair


def test_dry_run_writes_nothing_and_is_idempotent():
    c = _db()
    before = _rows(c)
    dir_.repair_dl_performance_sentinels(c, dry=True)
    assert _rows(c) == before
    dir_.repair_dl_performance_sentinels(c, dry=False)
    once = _rows(c)
    dir_.repair_dl_performance_sentinels(c, dry=False)
    assert _rows(c) == once
