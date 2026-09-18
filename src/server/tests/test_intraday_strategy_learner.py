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


class RecordingConnection:
    """Exercise run's real branching/writes without touching the production settings."""
    def __init__(self, count):
        self.rows = [dict(outcome='WIN' if i % 2 else 'LOSS', pnl_pct=1 if i % 2 else -1,
                          breakout_score=70, news_sentiment=.8, intraday_regime='BULL',
                          bullish_count=3, conviction_level='A_HIGH') for i in range(count)]
        self.settings = {'intraday_learned_weights': '{"incumbent": true}'}
        self.lift_writes = 0

    def execute(self, sql, params=()):
        if 'INSERT INTO app_settings' in sql:
            import re
            key = re.search(r"VALUES\('([^']+)'", sql).group(1)
            self.settings[key] = params[0]
        elif 'INSERT INTO intraday_strategy_lifts' in sql:
            self.lift_writes += 1
        return self

    def fetchall(self):
        return self.rows

    def cursor(self):
        return self

    def commit(self):
        pass


def test_in_sample_lift_never_overwrites_incumbent(capsys):
    import json
    conn = RecordingConnection(isl.MIN_TRADES * 2)
    result = isl.run(conn=conn)
    assert conn.settings['intraday_learned_weights'] == '{"incumbent": true}'
    assert result['published'] is False
    assert result['candidate_written'] is True
    candidate = json.loads(conn.settings['intraday_candidate_weights'])
    assert candidate['status'] == 'SHADOW_ONLY'
    assert candidate['validation'] == 'IN_SAMPLE_ONLY'
    assert candidate['trades'] == isl.MIN_TRADES * 2
    assert conn.lift_writes > 0
    report = json.loads(capsys.readouterr().out)
    assert report['weights_published'] is False
    assert report['promotion_blocked_reason']


def test_thin_sample_writes_lifts_without_candidate():
    conn = RecordingConnection(isl.MIN_TRADES - 1)
    result = isl.run(conn=conn)
    assert result['published'] is False
    assert result['candidate_written'] is False
    assert 'intraday_candidate_weights' not in conn.settings
    assert conn.lift_writes > 0


def test_empty_sample_never_changes_settings():
    conn = RecordingConnection(0)
    assert isl.run(conn=conn) == {'trades': 0}
    assert conn.settings == {'intraday_learned_weights': '{"incumbent": true}'}
    assert conn.lift_writes == 0
