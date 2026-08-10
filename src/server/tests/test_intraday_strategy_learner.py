"""
Regression test for the 2026-08 direction filter in intraday_strategy_learner.py.

Once intraday_recommendation_outcomes gained a `direction` column (Sell/Strong-Sell outcomes
are now resolved too, alongside Buy/Strong-Buy), a symbol/day can have BOTH a LONG and a SHORT
outcome row. The learner's join to intraday_recommendations (one row per symbol/day) has no
direction key of its own, so without an explicit filter it would return both rows against the
same recommendation row -- silently double-counting that symbol/day and conflating "this signal
preceded a good long" with "this signal preceded a good short" under one bucket, two bets this
codebase treats as unrelated (see intraday_ranker.py's EMISSION_GATE_SETTING_SHORT).

Source-inspection rather than a full behavioural harness: what matters here is that the filter
clause is present and hasn't been silently reverted, not a subtle edge case in the bucketing
math (which predates this change and is unaffected by it).
"""

import inspect
import os
import sys

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import intraday_strategy_learner as isl


def test_query_filters_to_long_direction():
    src = inspect.getsource(isl.run)
    assert "o.direction = 'LONG'" in src, (
        "intraday_strategy_learner.run() must filter its outcomes join to direction='LONG' -- "
        "without it, a symbol/day with both a LONG and SHORT resolved outcome would be joined "
        "twice against the same intraday_recommendations row, silently double-counting it and "
        "mixing two unrelated bets' win rates into one signal bucket."
    )
