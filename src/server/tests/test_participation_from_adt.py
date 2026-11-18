import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from indian_market_costs import participation_from_adt, MAX_PARTICIPATION


def test_zero_turnover_is_the_illiquid_cap_not_the_liquid_floor():
    """AF-20261117-09: both cost maps used participation 0.01 (the most liquid case) when the
    20-day average turnover was 0, pricing an untraded stock as the cheapest to trade."""
    assert participation_from_adt(0.0) == MAX_PARTICIPATION
    assert participation_from_adt(None) == MAX_PARTICIPATION


def test_participation_scales_with_turnover_and_caps():
    assert participation_from_adt(100_000_000.0) == 0.01        # 10L of 10Cr
    assert participation_from_adt(1_000_000.0) == MAX_PARTICIPATION


def test_both_cost_maps_use_the_shared_helper():
    here = os.path.join(os.path.dirname(__file__), '..')
    for f in ('unified_ranker.py', 'scoring_engine.py'):
        src = open(os.path.join(here, f), encoding='utf-8').read()
        assert 'if adt > 0 else 0.01' not in src, f
        assert 'participation_from_adt(' in src, f
