"""event_triggers: the three measured event signals.

Each test pins a decision made from a MEASUREMENT, not from intuition, so changing the
behaviour should mean re-running the measurement rather than editing an expectation.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import numpy as np
import pandas as pd
import pytest

import event_triggers as et

AS_OF = pd.Timestamp('2026-08-10')


def _sc(rows):
    return pd.DataFrame(rows, columns=['symbol', 'appeared', 'exited', 'bias'])


class TestExitRatioIsTheSignalNotTheCount:
    """Measured: raw exit COUNT gives 21d IC -0.0165 (t=-1.47); exits as a SHARE of the
    symbol's own bullish membership gives -0.0336 (t=-5.37). Screener membership churns
    daily, so losing 1 of 20 screens is the base rate, not an event."""

    def test_ratio_separates_symbols_the_raw_count_cannot(self):
        gone = AS_OF - pd.Timedelta(days=1)
        old = AS_OF - pd.Timedelta(days=40)
        rows = ([('BIGCO', old, gone, 'bullish')] * 3
                + [('BIGCO', old, None, 'bullish')] * 30
                + [('SMALLCO', old, gone, 'bullish')] * 3
                + [('SMALLCO', old, None, 'bullish')])
        out = et.compute_screener_events(_sc(rows), AS_OF).set_index('symbol')
        assert out.loc['BIGCO', 'bullish_exits_5d'] == 3
        assert out.loc['SMALLCO', 'bullish_exits_5d'] == 3
        assert (out.loc['SMALLCO', 'bullish_exit_ratio_5d']
                > out.loc['BIGCO', 'bullish_exit_ratio_5d'])
        assert out.loc['BIGCO', 'bullish_exit_ratio_5d'] == pytest.approx(3 / 33)

    def test_no_bullish_membership_is_nan_not_zero(self):
        """'Nothing to lose' and 'lost nothing' are different statements; ranking them
        together is part of why the raw count was weak. A symbol with no bullish involvement
        at all produces no row; one that IS in the output but holds nothing bullish must get
        NaN rather than a 0 that would rank alongside genuinely intact names."""
        out = et.compute_screener_events(
            _sc([('NOBULL', AS_OF - pd.Timedelta(days=10),
                  AS_OF - pd.Timedelta(days=1), 'bearish')]), AS_OF
        ).set_index('symbol')
        assert out.loc['NOBULL', 'bearish_exits_5d'] == 1
        assert pd.isna(out.loc['NOBULL', 'bullish_exit_ratio_5d'])

    def test_symbol_with_no_bullish_involvement_produces_no_row(self):
        out = et.compute_screener_events(
            _sc([('QUIET', AS_OF - pd.Timedelta(days=10), None, 'bearish')]), AS_OF)
        assert 'QUIET' not in set(out['symbol'])

    def test_exits_outside_the_window_do_not_count(self):
        stale = AS_OF - pd.Timedelta(days=et.EXIT_LOOKBACK_DAYS + 10)
        out = et.compute_screener_events(
            _sc([('OLD', AS_OF - pd.Timedelta(days=60), stale, 'bullish'),
                 ('OLD', AS_OF - pd.Timedelta(days=60), None, 'bullish')]), AS_OF
        ).set_index('symbol')
        assert out.loc['OLD', 'bullish_exits_5d'] == 0


class TestTenure:
    """Measured IC +0.0315 at 21d (t=+6.14), still +0.0214 (t=+2.95) after residualising on
    21d and 63d momentum -- so it is NOT a momentum proxy."""

    def test_tenure_is_mean_age_of_ACTIVE_bullish_memberships(self):
        out = et.compute_screener_events(
            _sc([('A', AS_OF - pd.Timedelta(days=60), None, 'bullish'),
                 ('A', AS_OF - pd.Timedelta(days=20), None, 'bullish')]), AS_OF
        ).set_index('symbol')
        assert out.loc['A', 'bullish_tenure_days'] == pytest.approx(40.0)

    def test_exited_memberships_do_not_inflate_tenure(self):
        """A long-held screen the stock has already LOST must stop crediting it."""
        out = et.compute_screener_events(
            _sc([('A', AS_OF - pd.Timedelta(days=60), AS_OF - pd.Timedelta(days=1), 'bullish'),
                 ('A', AS_OF - pd.Timedelta(days=10), None, 'bullish')]), AS_OF
        ).set_index('symbol')
        assert out.loc['A', 'bullish_tenure_days'] == pytest.approx(10.0)

    def test_bearish_membership_does_not_count_toward_bullish_tenure(self):
        out = et.compute_screener_events(
            _sc([('A', AS_OF - pd.Timedelta(days=60), None, 'bearish'),
                 ('A', AS_OF - pd.Timedelta(days=10), None, 'bullish')]), AS_OF
        ).set_index('symbol')
        assert out.loc['A', 'bullish_tenure_days'] == pytest.approx(10.0)


class TestNewsIsPointInTime:
    """30.3% of linked articles are fetched more than a day after publication, and
    MoneyControl's per-stock endpoint averages a 315-hour backlog. Counting an article at
    date D that only entered the DB later is a look-ahead. Corrected IC -0.1356 (t=-5.00)
    vs -0.1032 on published_at alone -- the fix STRENGTHENED the signal."""

    @staticmethod
    def _news(rows):
        return pd.DataFrame(
            rows, columns=['symbol', 'published_at', 'fetched_at', 'sentiment_score'])

    def test_article_fetched_after_the_as_of_date_is_excluded(self):
        n = self._news([
            ('SEEN', '2026-08-08T04:00:00Z', '2026-08-08T05:00:00Z', 0.5),
            ('LATE', '2026-08-08T04:00:00Z', '2026-08-20T05:00:00Z', 0.5),   # backfilled later
        ])
        syms = set(et.compute_news_events(n, AS_OF)['symbol'])
        assert 'SEEN' in syms
        assert 'LATE' not in syms, 'counted an article not yet in the DB on the as-of date'

    def test_missing_fetched_at_falls_back_to_published(self):
        """Never drop a row purely because provenance is missing -- degrade, do not delete."""
        n = self._news([('X', '2026-08-08T04:00:00Z', None, 0.4)])
        assert 'X' in set(et.compute_news_events(n, AS_OF)['symbol'])

    def test_articles_outside_the_lookback_window_do_not_count(self):
        n = self._news([('OLD', '2026-06-01T04:00:00Z', '2026-06-01T05:00:00Z', 0.4)])
        assert et.compute_news_events(n, AS_OF).empty

    def test_attention_percentile_is_cross_sectional(self):
        rows = ([('LOUD', '2026-08-08T04:00:00Z', '2026-08-08T05:00:00Z', 0.1)] * 10
                + [('QUIET', '2026-08-08T04:00:00Z', '2026-08-08T05:00:00Z', 0.1)])
        out = et.compute_news_events(self._news(rows), AS_OF).set_index('symbol')
        assert (out.loc['LOUD', 'news_attention_pctile']
                > out.loc['QUIET', 'news_attention_pctile'])


class TestTriggerTags:
    """No binary exit flag exists on purpose. Measured fire rates: ratio>0.00 fires on 74%
    (t=-2.33), >0.25 on 52% (t=-1.69), >0.50 on 17% (t=-0.41), and >0.75 FLIPS POSITIVE
    (+0.485%). There is no defensible cut, so only the top decile is tagged, as a RANK."""

    def test_a_single_lost_screener_does_not_raise_a_flag(self):
        assert et.build_triggers({'bullish_exit_ratio_5d': 0.05}) == ''

    def test_top_decile_ratio_is_tagged(self):
        assert 'SCREENER_SUPPORT_FADING' in et.build_triggers(
            {'bullish_exit_ratio_5d': et.EXIT_RATIO_TOP_DECILE})

    def test_crowded_news_tagged_at_the_measured_quintile(self):
        assert 'CROWDED_NEWS' in et.build_triggers(
            {'news_attention_pctile': et.NEWS_CROWDED_PCTILE})
        assert et.build_triggers({'news_attention_pctile': 0.5}) == ''

    def test_nan_inputs_do_not_raise(self):
        assert et.build_triggers({'bullish_exit_ratio_5d': np.nan,
                                  'news_attention_pctile': np.nan}) == ''


class TestNanSafeInt:
    def test_int_of_nan_is_zero_not_a_crash(self):
        """`int(x or 0)` does NOT work: NaN is truthy, so `NaN or 0` is NaN and int(NaN)
        raises. Same idiom behind the 2026-07-31 NaN-score incident."""
        assert et._i(np.nan) == 0
        assert et._i(None) == 0
        assert et._i(3.7) == 3
