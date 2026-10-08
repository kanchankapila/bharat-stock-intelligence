"""AF-20261008-03: the intraday target was said to be unreachable (5.6% of LONG trades reach it).
intraday_target_replay re-grades the stored day-bars with the target distance scaled, cost-aware
and stop-first, so "move the target nearer" is measured before anyone changes `_atr_barriers`.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import intraday_target_replay as itr  # noqa: E402

# (direction, entry, target, stop, day_high, day_low, day_close)
LONG_REACH_HALF = ('LONG', 100.0, 104.0, 98.0, 102.5, 99.0, 101.0)   # reaches 2.5% = 0.625x of a 4% target
LONG_STOPPED = ('LONG', 100.0, 104.0, 98.0, 105.0, 97.0, 100.0)      # touches both: stop first


class TestReplayTrade:
    def test_full_distance_target_not_reached(self):
        kind, ret = itr.replay_trade(LONG_REACH_HALF, 1.0, cost=0.3)
        assert kind == 'CLOSE'
        assert round(ret, 4) == round(1.0 - 0.3, 4)

    def test_nearer_target_is_reached_and_books_the_scaled_distance(self):
        kind, ret = itr.replay_trade(LONG_REACH_HALF, 0.5, cost=0.3)   # target now +2%
        assert kind == 'TARGET'
        assert round(ret, 4) == round(2.0 - 0.3, 4)

    def test_a_day_that_touches_both_is_a_stop(self):
        kind, ret = itr.replay_trade(LONG_STOPPED, 0.5, cost=0.3)
        assert kind == 'STOP'
        assert round(ret, 4) == round(-2.0 - 0.3, 4)

    def test_short_mirrors_the_long(self):
        row = ('SHORT', 100.0, 96.0, 102.0, 101.0, 97.5, 99.0)
        assert itr.replay_trade(row, 1.0, cost=0.0)[0] == 'CLOSE'
        kind, ret = itr.replay_trade(row, 0.5, cost=0.0)             # target now -2%
        assert kind == 'TARGET' and round(ret, 4) == 2.0


class TestSummary:
    def test_hit_rates_rise_as_the_target_moves_nearer(self):
        rows = [LONG_REACH_HALF] * 4
        far = itr.summarise(rows, 'LONG', 1.0, cost=0.3)
        near = itr.summarise(rows, 'LONG', 0.5, cost=0.3)
        assert far['target'] == 0.0 and near['target'] == 100.0
        assert near['n'] == 4
