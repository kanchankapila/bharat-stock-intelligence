"""AF-20261126-11: labels that were wrong under any reading of the screener's own condition."""
import pytest

from screener_bias_pins import pinned_bias


@pytest.mark.parametrize("name,expected", [
    # closes below the prior low, stored bullish because the name contains "breakout"
    ("Previous Day Breakout - Down Stocks which have closed below their previous day's low price", "bearish"),
    ("Previous Month Breakout - Down Stocks which have closed below their previous month's low price", "bearish"),
    # %B < 0, the superset of "Bollinger Band Breakdown" (bearish)
    ("Price crossed below 15 min Bollinger Band", "bearish"),
    ("Price crossed below 1H Bollinger Band", "bearish"),
    ("Price crossed below Week Bollinger Band", "bearish"),
    # ADX has no direction
    ("15 min ADX Strong Trending Stocks", "neutral"),
    ("ADX Strong Trending Stocks", "neutral"),
    # the same RSI condition also sits in an oppositely labelled screener
    ("Oversold on both 15 min RSI and 15 min MFI", "neutral"),
    ("Overbought on both RSI and MFI", "neutral"),
])
def test_pinned(name, expected):
    assert pinned_bias(name) == expected


@pytest.mark.parametrize("name", [
    "Previous Day Breakout - Up List of stocks which have closed above their previous day's high price",
    "Price crossed above 15 min Bollinger Band",
    "Price crossed below 15 min Bollinger Band Central Line",
    "15 min ADX Bullish Divergence",
    "15 min CCI Oversold",          # pinned disagreement, AF-20260829-11: owner decision, untouched
    "Oversold - RSI below 30 Stocks having RSI below 30",   # measured daily rule keeps it bearish
    "15 min Relative Strength Index (RSI) bullish",
    "", None,
])
def test_everything_else_is_left_to_the_existing_writers(name):
    assert pinned_bias(name) is None
