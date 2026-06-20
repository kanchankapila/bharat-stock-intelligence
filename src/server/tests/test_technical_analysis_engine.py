import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Pure barrier math only — no DB/engine instantiation (TechnicalAnalysisEngine.__init__
# opens a connection). compute_atr_barriers replaces the old fixed +8%/-5% levels, which
# were noise on a high-vol stock and untouchable on a low-vol one.
from technical_analysis_engine import (  # noqa: E402
    compute_atr_barriers,
    STOP_PCT_FLOOR, STOP_PCT_CAP,
    TARGET_PCT_FLOOR, TARGET_PCT_CAP,
)

PRICE = 100.0


def test_long_barriers_bracket_price():
    # ATR 2% of price, mults 2.5x target / 1.5x stop -> 5% target, 3% stop (inside guardrails)
    target, stop = compute_atr_barriers(PRICE, atr=2.0, direction='long')
    assert target > PRICE > stop
    assert target == 105.0   # 100 * (1 + 2.5*0.02)
    assert stop == 97.0      # 100 * (1 - 1.5*0.02)


def test_short_barriers_invert():
    target, stop = compute_atr_barriers(PRICE, atr=2.0, direction='short')
    assert target < PRICE < stop
    assert target == 95.0
    assert stop == 103.0


def test_higher_atr_widens_barriers():
    t_low, s_low = compute_atr_barriers(PRICE, atr=1.0, direction='long')
    t_hi,  s_hi  = compute_atr_barriers(PRICE, atr=3.0, direction='long')
    assert (t_hi - PRICE) > (t_low - PRICE)   # wider target
    assert (PRICE - s_hi) > (PRICE - s_low)   # wider stop


def test_extreme_atr_clamped_to_cap():
    # ATR 50% of price would imply absurd barriers; clamp to the % caps.
    target, stop = compute_atr_barriers(PRICE, atr=50.0, direction='long')
    assert target == round(PRICE * (1 + TARGET_PCT_CAP), 2)
    assert stop == round(PRICE * (1 - STOP_PCT_CAP), 2)


def test_tiny_atr_clamped_to_floor():
    target, stop = compute_atr_barriers(PRICE, atr=0.01, direction='long')
    assert target == round(PRICE * (1 + TARGET_PCT_FLOOR), 2)
    assert stop == round(PRICE * (1 - STOP_PCT_FLOOR), 2)


def test_zero_atr_falls_back_to_floor_not_price():
    target, stop = compute_atr_barriers(PRICE, atr=0.0, direction='long')
    assert target == round(PRICE * (1 + TARGET_PCT_FLOOR), 2)
    assert stop == round(PRICE * (1 - STOP_PCT_FLOOR), 2)
    assert stop < PRICE < target  # never degenerate to price/zero


def test_nonpositive_price_returns_zeros():
    assert compute_atr_barriers(0.0, atr=2.0, direction='long') == (0.0, 0.0)
