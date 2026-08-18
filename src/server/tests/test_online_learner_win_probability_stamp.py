"""Regression test: score_pending_with_ensemble_blend() must stamp
win_probability_scored_at alongside win_probability.

online_learner.py runs before ml_ensemble.py's do_score pass in the daily job chain
(queues.ts) and fills win_probability for the whole universe with no timestamp. Because
do_score's own candidate query is `WHERE win_probability IS NULL`, it then finds nothing
left to score and its own stamping UPDATE (ml_ensemble.py:2928) never fires for those rows.
Confirmed live 2026-08-18: win_probability_scored_at was 0% populated on 7 of the last 9
trading days, 100% on the one day the two writers didn't race this way. See recurring-bugs.md
-- same shape as "a backfill loop that gates re-selection on a column an earlier writer
already filled".
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import online_learner as ol
import ml_ensemble


class _FakeCursor:
    def __init__(self):
        self.executemany_calls = []

    def executemany(self, sql, params_seq):
        self.executemany_calls.append((sql, list(params_seq)))


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()
        self.committed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


def test_stamps_win_probability_scored_at(monkeypatch):
    monkeypatch.setattr(ml_ensemble, "build_features", lambda df: pd.DataFrame({"f": [0.0] * len(df)}))
    monkeypatch.setattr(ol, "predict_sgd", lambda state, X: [0.6] * len(X))

    conn = _FakeConn()
    df = pd.DataFrame({"symbol": ["AAA"], "signal_date": ["2026-08-18"]})

    ol.score_pending_with_ensemble_blend(conn, sgd_state={}, ensemble=None, df=df)

    assert len(conn.cur.executemany_calls) == 1
    sql, params = conn.cur.executemany_calls[0]
    assert "win_probability_scored_at" in sql
    assert "CURRENT_TIMESTAMP" in sql
    assert params == [(0.6, "AAA", "2026-08-18")]
    assert conn.committed == 1
