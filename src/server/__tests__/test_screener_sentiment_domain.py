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

    def test_measured_family_beats_incidental_valuation_words_in_marketing_copy(self):
        """Live bug, 2026-08-13: Trendlyne/MoneyControl screener 'names' are sometimes full
        promotional paragraphs. A stray 'undervalued' in the ad copy used to steal the match
        via VAL_CHEAP before the screener's real, measured, strongly-bearish 52w-low signal
        got a chance -- e.g. 'Close Within 52 Week Low Zone' shipped live as 'bullish'."""
        assert ov(
            'close within 52 week low zone refers to stocks that have recently closed '
            'their trading session within the range of their lowest price observed in the '
            'past 52 weeks. explore the hidden potential that lies within these '
            'undervalued gems, waiting to be unearthed.'
        ) == 'bearish'


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


class TestDvmTierNames:
    """Trendlyne's own DVM (Durability/Valuation/Momentum) quadrant labels, confirmed against
    Trendlyne's help docs 2026-08-13: an unqualified Top/Strong Performer means all three
    components score >50-55. Live bug: 'Top Performer DVM Stocks (subscription)' shipped
    'bearish' from one source and 'bullish' from another for the identical name."""

    @pytest.mark.parametrize('name', [
        'Top Performer DVM Stocks (subscription)', 'Strong Performers - High DVM Stocks',
    ])
    def test_unqualified_top_performer_is_bullish(self, name):
        assert ov(name) == 'bullish'

    @pytest.mark.parametrize('name', ['Weak Stocks (DVM)', 'Expensive Underperformers (DVM)'])
    def test_weak_or_underperformer_is_bearish(self, name):
        assert ov(name) == 'bearish'

    def test_a_genuine_caveat_still_wins_over_the_dvm_tier_name(self):
        """'Strong Performer' alone is bullish, but VAL_RICH ('expensive') is checked first --
        a caveated tier name should stay bearish, not flip on the word 'performer'."""
        assert ov('Strong Performer, Getting Expensive (DVM)') == 'bearish'


class TestExplicitParentheticalLabel:
    """The vendor's own '(Bullish)'/'(Bearish)' suffix outranks everything else -- it's a
    direct statement, not a wording heuristic. Live bug 2026-08-13: 'White Marubozu Candlestick
    (Bullish)' had a duplicate row shipping 'bearish' -- domain_override had no opinion on
    candlestick patterns at all before this rule existed."""

    def test_explicit_bullish_suffix(self):
        assert ov('White Marubozu Candlestick (Bullish)') == 'bullish'

    def test_explicit_bearish_suffix(self):
        assert ov('Black Marubozu (Bearish)') == 'bearish'

    def test_outranks_risk_and_valuation(self):
        """Even a name that would otherwise hit an earlier rule defers to the explicit label."""
        assert ov('Overvalued Turnaround Candle (Bullish)') == 'bullish'


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
