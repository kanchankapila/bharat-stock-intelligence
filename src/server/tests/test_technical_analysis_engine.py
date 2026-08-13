import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Pure barrier math only — no DB/engine instantiation (TechnicalAnalysisEngine.__init__
# opens a connection). compute_atr_barriers replaces the old fixed +8%/-5% levels, which
# were noise on a high-vol stock and untouchable on a low-vol one.
from technical_analysis_engine import (  # noqa: E402
    compute_atr_barriers,
    STOP_PCT_FLOOR, STOP_PCT_CAP,
    TARGET_PCT_FLOOR, TARGET_PCT_CAP,
    to_unified_signal_row,
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


# ── to_unified_signal_row: technical_analysis_signals -> unified_signals fold ──────────
# (Cluster B-lite, 2026-08) trend->signal_type, rsi->technical_score (must stay numeric,
# not text, so strategySignalsService's `rsi <= ?` filter keeps working), patterns (JSON
# string) -> ai_reasoning (so mcpServer's JSON.parse(...) keeps working unchanged).

def test_to_unified_signal_row_maps_trend_rsi_patterns():
    row = {
        'symbol': 'INFY', 'trend': 'Bullish', 'rsi': 62.345,
        'macd': 'Bullish Crossover', 'bollinger': 'Normal',
        'patterns': '["Doji"]', 'entry_price': 1500.0,
        'target_price': 1550.0, 'stop_loss': 1470.0,
        'last_updated': '2026-08-03T18:00:00',
    }
    out = to_unified_signal_row(row, signal_date='2026-08-03')

    assert out['symbol'] == 'INFY'
    assert out['signal_date'] == '2026-08-03'
    assert out['signal_type'] == 'Bullish'
    assert out['technical_score'] == 62.345
    assert out['ai_reasoning'] == '["Doji"]'
    assert 'RSI=62.3' in out['reasoning']
    assert 'MACD=Bullish Crossover' in out['reasoning']
    assert 'BB=Normal' in out['reasoning']
    assert out['entry_price'] == 1500.0
    assert out['target_price'] == 1550.0
    assert out['stop_loss'] == 1470.0
    assert out['signal_generated_at'] == '2026-08-03T18:00:00'


def test_to_unified_signal_row_preserves_bearish_and_empty_patterns():
    row = {
        'symbol': 'TCS', 'trend': 'Bearish', 'rsi': 71.0,
        'macd': 'Bearish', 'bollinger': 'High',
        'patterns': '[]', 'entry_price': 3500.0,
        'target_price': 3400.0, 'stop_loss': 3560.0,
        'last_updated': '2026-08-03T18:00:00',
    }
    out = to_unified_signal_row(row, signal_date='2026-08-03')

    assert out['signal_type'] == 'Bearish'
    assert out['ai_reasoning'] == '[]'
    assert out['technical_score'] == 71.0


# ── naive-local-clock regression guard (2026-08-13) ─────────────────────────────
# analyze_stock()/process_all() need a live DB connection (TechnicalAnalysisEngine.__init__
# opens one) so this checks the source directly rather than mocking a DB just to exercise two
# lines. A naive datetime.datetime.now() on this host's IST-configured local clock lands
# ~5:30 ahead of true UTC once stored in a TIMESTAMPTZ column (signal_generated_at), and
# produces TOMORROW's calendar date for signal_date on any run after 18:30 UTC/00:00 IST --
# see recurring-bugs.md and the fix's own inline comments in technical_analysis_engine.py.

def test_last_updated_and_signal_date_are_not_naive_local_time():
    import inspect
    import technical_analysis_engine as tae
    src = inspect.getsource(tae)
    assert "datetime.datetime.now().isoformat()" not in src
    assert "datetime.datetime.now().date().isoformat()" not in src
    assert "datetime.datetime.now(datetime.timezone.utc)" in src
    assert "logical_write_floor" in src
