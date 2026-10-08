"""AF-20261008-02: the stop / target / valid_until the ranker publishes on every Buy were never
graded -- no writer puts ranker picks in unified_signals, and forward_test_report grades score vs
forward return, not whether the plan hit its levels. plan_outcome_report replays each published
plan on the bars, with the lifecycle closer's own conventions (first touch wins, same bar both =
stop, a gap fills at the open), and refuses to grade a plan that is already invalid at the open.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import plan_outcome_report as por  # noqa: E402


def bars(*rows):
    return [(f'2026-09-{i + 1:02d}', o, h, l, c) for i, (o, h, l, c) in enumerate(rows)]


class TestGradePlan:
    def test_target_touch_books_the_target_net_of_cost(self):
        r = por.grade_plan(bars((100, 104, 99, 103), (103, 112, 102, 111)), 100.0, 95.0, 110.0, True)
        assert r[0] == 'TARGET'
        assert round(r[1], 4) == round(10.0 - por.COST, 4)

    def test_stop_touch_books_the_stop_net_of_cost(self):
        r = por.grade_plan(bars((100, 101, 94, 96)), 100.0, 95.0, 110.0, True)
        assert r[0] == 'STOP'
        assert round(r[1], 4) == round(-5.0 - por.COST, 4)

    def test_a_bar_touching_both_is_a_stop(self):
        r = por.grade_plan(bars((100, 112, 94, 100)), 100.0, 95.0, 110.0, True)
        assert r[0] == 'STOP'

    def test_gap_through_the_stop_fills_at_the_open_not_the_stop(self):
        r = por.grade_plan(bars((100, 101, 99, 100), (90, 92, 89, 91)), 100.0, 95.0, 110.0, True)
        assert r[0] == 'STOP'
        assert round(r[1], 4) == round(-10.0 - por.COST, 4), 'a gap loses more than the planned 5%'

    def test_window_end_without_a_touch_exits_at_the_last_close(self):
        r = por.grade_plan(bars((100, 104, 98, 102), (102, 105, 99, 103)), 100.0, 95.0, 110.0, True)
        assert r[0] == 'TIME'
        assert round(r[1], 4) == round(3.0 - por.COST, 4)

    def test_incomplete_window_is_not_graded(self):
        assert por.grade_plan(bars((100, 104, 98, 102)), 100.0, 95.0, 110.0, False) is None


class TestPlanValidAtEntry:
    def test_open_inside_the_band_is_valid(self):
        assert por.plan_valid_at_open(100.0, 95.0, 110.0) is True

    def test_open_through_the_stop_or_the_target_is_not(self):
        assert por.plan_valid_at_open(94.0, 95.0, 110.0) is False
        assert por.plan_valid_at_open(111.0, 95.0, 110.0) is False

    def test_missing_levels_are_not_valid(self):
        assert por.plan_valid_at_open(100.0, None, 110.0) is False


class TestScaleLevels:
    def test_identity_scale_keeps_the_published_levels(self):
        assert por.scale_levels(100.0, 95.0, 110.0) == (95.0, 110.0)

    def test_scales_each_distance_from_entry_independently(self):
        stop, target = por.scale_levels(100.0, 95.0, 110.0, stop_scale=0.5, target_scale=2.0)
        assert (round(stop, 6), round(target, 6)) == (97.5, 120.0)
