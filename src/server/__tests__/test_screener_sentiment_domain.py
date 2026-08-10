"""domain_override: the screener-sentiment rules that the generic keyword layers get wrong.

Two distinct classes of rule are pinned here and the distinction matters:
  * MEASURED  -- oversold / near-52w-low / below-lower-BB / overbought were settled by a
    5-year backtest of the reconstructed condition (factor_backtest.py --factor
    screener_oversold etc). Changing these should require re-running that, not an opinion.
  * REASONED  -- bare dividend yield and scheduled-event screeners abstain because the data
    to test them does not exist in this database. Labelled as such deliberately.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from nlp_engine import NLPScreenerInference as NLP


def ov(name):
    return NLP.domain_override(name.lower())


class TestRiskTermsInvertOnHighLow:
    """'High'/'increasing' on a RISK subject is bearish; the generic lists read it as bullish
    because they match the bare words 'high' and 'increasing'."""

    @pytest.mark.parametrize('name', [
        'High Leverage', 'High Pledge', 'Increasing Promoter Pledge', 'Rising Debt',
        'Companies Increasing Debt as per Annual Report',
    ])
    def test_rising_risk_is_bearish(self, name):
        assert ov(name) == 'bearish'

    @pytest.mark.parametrize('name', [
        'Zero Debt companies', 'Debt Free', 'Decreasing Debt to Equity', 'Low Debt Stocks',
    ])
    def test_falling_risk_is_bullish(self, name):
        assert ov(name) == 'bullish'


class TestValuationInvertsOnHighLow:
    """'Low' on a valuation MULTIPLE is cheap = bullish -- the opposite of 'low' on a
    momentum or quality metric, which is why a single high/low rule cannot work."""

    @pytest.mark.parametrize('name', [
        'Low Price to Book', 'Low P/E Ratio Stocks', 'Undervalued Stocks P/B ratio less than 1',
        'Quality Stocks at Discount', 'Small-Cap Value Stocks undervalued',
    ])
    def test_cheap_is_bullish(self, name):
        assert ov(name) == 'bullish'

    @pytest.mark.parametrize('name', ['Expensive Performers (DVM)', 'High P/E stocks',
                                      'Overvalued Stocks'])
    def test_rich_is_bearish(self, name):
        assert ov(name) == 'bearish'

    @pytest.mark.parametrize('name', ['High ROE', 'High Dividend Yield with Low Debt',
                                      'Low Delivery Volume', 'Low Volatility Stocks'])
    def test_low_high_on_non_valuation_does_not_get_the_valuation_rule(self, name):
        """Guard against the scoping being widened until 'low anything' reads as cheap."""
        assert ov(name) != 'bearish' or 'volatil' in name.lower()


class TestMeasuredFamilies:
    """MEASURED, not read off the name. 5y / 64 monthly rebalances / top-50 / 25bps:
       oversold -1.25%/mo t=-4.26 (0 of 6 years positive)
       near 52w low -1.21%/mo t=-3.79 (0 of 6)
       below lower BB -1.10%/mo t=-4.70 (0 of 6)
       overbought -0.09%/mo t=-0.18 (no signal either way)
    The textbook 'oversold = buy the dip' reading is WRONG on this universe."""

    @pytest.mark.parametrize('name', [
        'Oversold on both 30 min RSI and 30 min MFI', 'Willaims %R in Oversold zone',
        'Below Lower BB', 'Crossed Below Lower BB',
        'New 52 Week Low', 'New 10-year low today', '52 Week Low',
    ])
    def test_stretched_down_is_bearish_not_a_dip_buy(self, name):
        assert ov(name) == 'bearish'

    @pytest.mark.parametrize('name', [
        'Overbought on both Week MFI and Week RSI', 'Week Williams %R in Overbought zone',
    ])
    def test_overbought_abstains_because_it_carries_no_measured_signal(self, name):
        assert ov(name) == 'neutral'

    def test_the_two_directions_are_not_symmetric(self):
        """The whole point of the measurement: this is NOT 'oversold bearish therefore
        overbought bullish'. Stretched-down predicts; stretched-up does not."""
        assert ov('oversold zone') == 'bearish'
        assert ov('overbought zone') == 'neutral'


class TestReasonedAbstentions:
    """REASONED, not measured -- flagged so nobody cites these as empirical."""

    @pytest.mark.parametrize('name', ['High Dividend Yield Stocks', 'Dividend Opportunities'])
    def test_bare_dividend_yield_abstains(self, name):
        assert ov(name) == 'neutral'

    @pytest.mark.parametrize('name', [
        'Dividend Stocks with Low Debt', 'High-Quality Dividend Stocks with Low P/E'])
    def test_qualified_dividend_takes_direction_from_the_qualifier(self, name):
        assert ov(name) == 'bullish'

    @pytest.mark.parametrize('name', ['Upcoming results for Nifty500 companies',
                                      'Board Meeting', 'Results due this week'])
    def test_scheduled_event_is_not_a_direction(self, name):
        assert ov(name) == 'neutral'


class TestFallsThroughWhenItHasNoOpinion:
    """The override must stay NARROW. Anything outside its families returns None so the
    existing FinBERT + keyword path still runs -- this is a targeted patch, not a rewrite."""

    @pytest.mark.parametrize('name', [
        'Crossed Below SMA-20', 'Golden Cross 30 day over 200 day', 'Top gainers of the past 1 year',
        'FII Buying', 'Hourly Losers', 'Positive Breakout - Medium Trend',
    ])
    def test_returns_none(self, name):
        assert ov(name) is None

    def test_empty_and_none_are_safe(self):
        assert ov('') is None and NLP.domain_override(None) is None
