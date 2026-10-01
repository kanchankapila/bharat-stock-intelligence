"""AF-20260930-32: technical_analysis_engine picked barrier direction on `trend == 'Bullish' or
rsi < 35`, so a Bearish-labelled signal with RSI < 35 got LONG geometry -- 7,399 of 26,547
Bearish signals in September (28%). The geometry must follow the label it is published under."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from technical_analysis_engine import trade_levels


def _is_long(target, stop):
    return target > stop


def test_bearish_label_gets_short_geometry_even_when_oversold():
    _, target, stop = trade_levels('Bearish', rsi=28.0, price=100.0, atr=2.0)
    assert not _is_long(target, stop)


def test_bullish_label_gets_long_geometry_even_when_overbought():
    _, target, stop = trade_levels('Bullish', rsi=72.0, price=100.0, atr=2.0)
    assert _is_long(target, stop)


def test_neutral_uses_rsi_extremes():
    assert _is_long(*trade_levels('Neutral', rsi=30.0, price=100.0, atr=2.0)[1:])
    assert not _is_long(*trade_levels('Neutral', rsi=70.0, price=100.0, atr=2.0)[1:])
