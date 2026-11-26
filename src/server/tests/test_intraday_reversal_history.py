"""The reversal component must be recorded in intraday history, or no blend change can be replayed.

reversal_score carries 0.40 of the intraday blend and is the only component that measured the right
way round (measurement.md 2026-10-25), but until 2026-11-26 it was stored in neither intraday table, so
the 2026-11-26 rescale of the learned weights (c6272751) had no stored input to be graded against.
"""
import inspect
import re

import intraday_ranker as ir


def _history_insert(src):
    m = re.search(r"INSERT INTO intraday_recommendations_history\s*\((.*?)\)\s*VALUES\s*\((.*?)\)", src, re.S)
    assert m, "history INSERT not found"
    return [c.strip() for c in m.group(1).split(",")], m.group(2).count("?")


def test_history_records_reversal_score():
    cols, n_params = _history_insert(inspect.getsource(ir.IntradayRanker.run))
    assert "reversal_score" in cols
    assert len(cols) == n_params
