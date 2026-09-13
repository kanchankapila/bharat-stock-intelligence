"""The ensemble's live score query must supply every column its training query does.

build_features() reads columns via num(col, default), so a column the score query forgets is
silently a constant at inference while training saw real values. The 2026-08-30 cr_upgrades/
cr_downgrades fix landed in full_feature_score_sql() -- which only cs_ranker.py calls -- while
the ensemble's own scorer, load_pending_signals(), kept its inline query without them
(AF-20260913-04). Column sets are read from Postgres itself (LIMIT 0 against the empty
production schema), not parsed out of the SQL text.
"""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
me = pytest.importorskip("ml_ensemble")

# Set in Python after the query, or only meaningful for training.
TRAIN_ONLY = {"outcome", "return_pct"}
ADDED_AFTER_SCORE_QUERY = {"horizon_days", "vol_rank"}


class _Captured(Exception):
    pass


def _sql_of(monkeypatch, fn, *args):
    seen = []

    def cap(sql, *a, **k):
        seen.append(sql)
        raise _Captured

    monkeypatch.setattr(me, "read_df", cap)
    with pytest.raises(_Captured):
        fn(*args)
    return re.sub(r"\bLIMIT\s+\d+\s*$", "", seen[0].strip().rstrip(";"), flags=re.I)


def _columns(conn, sql):
    cur = conn.cursor()
    cur.execute(sql + " LIMIT 0")
    return [d[0] for d in cur.description]


def test_score_query_supplies_every_training_column(monkeypatch, pg_db_conn):
    train = set(_columns(pg_db_conn, _sql_of(monkeypatch, me.load_training_data, "triple_barrier")))
    score = set(_columns(pg_db_conn, _sql_of(monkeypatch, me.load_pending_signals)))
    assert len(train) > 200 and len(score) > 200, "scan found too few columns to be meaningful"
    missing = train - score - TRAIN_ONLY - ADDED_AFTER_SCORE_QUERY
    assert not missing, f"trained on but constant at inference: {sorted(missing)}"
