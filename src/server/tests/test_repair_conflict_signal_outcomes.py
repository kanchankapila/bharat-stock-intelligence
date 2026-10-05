"""AF-20260930-33: the unified grader graded signals the screener scan had itself withdrawn
(status INVALIDATED_CONFLICT: BUY then SELL the same day). The resolver now skips them, but the
outcome rows written before the fix still enter every screener win rate. The repair deletes exactly
the outcomes whose parent signal is INVALIDATED_CONFLICT."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
import data_integrity_repair as dir_  # noqa: E402


def _db():
    c = pg_memory_conn()
    c.execute("CREATE TABLE unified_signals (id INTEGER PRIMARY KEY, status TEXT)")
    c.execute("CREATE TABLE unified_signal_outcomes (id INTEGER PRIMARY KEY, unified_signal_id INTEGER, "
              "horizon_days INTEGER, outcome TEXT)")
    c.executemany("INSERT INTO unified_signals VALUES (?,?)", [
        (1, 'INVALIDATED_CONFLICT'), (2, 'ACTIVE'), (3, 'EXPIRED'), (4, None)])
    c.executemany("INSERT INTO unified_signal_outcomes VALUES (?,?,?,?)", [
        (10, 1, 1, 'LOSS'), (11, 1, 5, 'WIN'),       # withdrawn signal: both go
        (12, 2, 1, 'WIN'), (13, 3, 5, 'LOSS'),       # live / expired: keep
        (14, 4, 1, 'NEUTRAL'),                       # status NULL: keep
    ])
    c.commit()
    return c


def _ids(c):
    return sorted(r[0] for r in c.execute("SELECT id FROM unified_signal_outcomes").fetchall())


def test_deletes_only_outcomes_of_invalidated_conflict_signals():
    c = _db()
    dir_.repair_conflict_signal_outcomes(c, dry=False)
    assert _ids(c) == [12, 13, 14]


def test_dry_run_writes_nothing_and_second_run_is_a_no_op():
    c = _db()
    dir_.repair_conflict_signal_outcomes(c, dry=True)
    assert _ids(c) == [10, 11, 12, 13, 14]
    dir_.repair_conflict_signal_outcomes(c, dry=False)
    once = _ids(c)
    dir_.repair_conflict_signal_outcomes(c, dry=False)
    assert _ids(c) == once
