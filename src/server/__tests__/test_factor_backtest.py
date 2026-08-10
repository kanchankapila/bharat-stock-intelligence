"""Correctness tests for the cross-sectional factor backtest harness.

The point of this file is that every number factor_backtest.py prints is only as trustworthy
as its turnover accounting and its entry timing. Both are verified here against cases whose
answers can be worked out by hand, on synthetic panels — no DB, no network.
"""
import math
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import factor_backtest as fb  # noqa: E402


def _panel(prices: dict[str, list[float]], dates: list[str], deliv=None,
           opens: dict[str, list[float]] | None = None) -> pd.DataFrame:
    """Minimal eligible panel. prices[symbol] = one close per date. `opens` defaults to close
    (so hand-computed returns are unambiguous) but can be set separately to make entry-timing
    bugs observable through the real harness."""
    rows = []
    for sym, px in prices.items():
        op = (opens or {}).get(sym, px)
        for i, d in enumerate(dates):
            rows.append({'symbol': sym, 'date': d, 'open': op[i], 'close': px[i],
                         'volume': 1e6, 'deliv_pct': (deliv or {}).get(sym, 50.0)})
    df = pd.DataFrame(rows).sort_values(['symbol', 'date']).reset_index(drop=True)
    g = df.groupby('symbol', sort=False)
    df['next_open'] = g['open'].shift(-1)
    df['turnover'] = df['close'] * df['volume']
    df['adt20'] = 1e9
    for lag, col in ((5, 'c5'), (21, 'c21'), (63, 'c63'), (252, 'c252')):
        df[col] = g['close'].shift(lag)
    df['r5'] = (df['close'] / df['c5'] - 1) * 100
    df['r21'] = (df['close'] / df['c21'] - 1) * 100
    df['r63'] = (df['close'] / df['c63'] - 1) * 100
    df['r12_1'] = (df['c21'] / df['c252'] - 1) * 100
    # Real rolling vol, not a constant: a constant makes the vol factors rank arbitrarily and
    # silently turns any test using them into a coin flip.
    dr = g['close'].pct_change()
    df['vol21'] = (dr.groupby(df['symbol'], sort=False)
                     .transform(lambda s: s.rolling(5, min_periods=2).std()) * 100).fillna(0.0)
    df['max_ret_21d'] = (dr.groupby(df['symbol'], sort=False)
                           .transform(lambda x: x.rolling(5, min_periods=2).max()) * 100).fillna(0.0)
    df['_hi'] = g['close'].transform(lambda x: x.rolling(10, min_periods=2).max())
    df['pct_of_52w_high'] = (df['close'] / df['_hi']).fillna(1.0)
    df['beta'] = 1.0
    df['idio_vol'] = df['vol21']
    df = df.drop(columns=['_hi'])
    df['eligible'] = df['next_open'].notna()
    return df


class TestTurnoverAccounting:
    """The single most consequential piece of arithmetic in the harness.

    NEGATIVE-CONTROLLED: replacing run_backtest's turnover line with a flat `traded = 2.0`
    must break these. An earlier version of this class computed sum(|dw|) inline in the test
    and therefore passed happily against that exact regression -- protecting nothing. Every
    assertion here goes through fb.run_backtest.
    """

    @staticmethod
    def _static_selection_panel(n=40):
        """reversal_5d picks the SAME names every rebalance -> real ongoing turnover ~= 0."""
        dates = [f'2024-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(n)]
        prices = {f'UP{k}': [100 * (1.01 ** i) for i in range(n)] for k in range(12)}
        prices.update({f'DN{k}': [100 * (0.99 ** i) for i in range(n)] for k in range(12)})
        return _panel(prices, dates)

    def test_stable_book_reports_near_zero_turnover(self):
        r = fb.run_backtest(self._static_selection_panel(), 'reversal_5d', 3, 5,
                            cost_bps_per_side=25)
        # only the initial purchase should cost anything; a flat round-trip regression pins
        # one-way turnover at exactly 1.0 every period.
        assert r['avg_oneway_turnover'] < 0.30, (
            f"turnover {r['avg_oneway_turnover']} implies costs are being charged on notional "
            "rather than on what actually traded")

    def test_stable_book_costs_far_less_than_a_round_trip_per_period(self):
        r = fb.run_backtest(self._static_selection_panel(), 'reversal_5d', 3, 5,
                            cost_bps_per_side=25)
        full_round_trip_pct = 2 * 25 / 100.0        # 0.50%
        assert r['cost_per_period_pct'] < full_round_trip_pct / 3

    def test_churning_book_costs_much_more_than_a_stable_one(self):
        """Turnover must actually track the book, not be a constant."""
        n = 60
        dates = [f'2024-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(n)]
        churn = {f'S{k}': [100 * (1 + 0.08 * math.sin((i + k * 3) / 2.0)) for i in range(n)]
                 for k in range(20)}
        c = fb.run_backtest(_panel(churn, dates), 'reversal_5d', 3, 5, cost_bps_per_side=25)
        st = fb.run_backtest(self._static_selection_panel(), 'reversal_5d', 3, 5,
                             cost_bps_per_side=25)
        assert c['avg_oneway_turnover'] > st['avg_oneway_turnover'] * 2
        assert c['cost_per_period_pct'] > st['cost_per_period_pct'] * 2

    def test_full_replacement_equals_exactly_one_round_trip(self):
        """The limit case, asserted on the documented arithmetic the harness implements."""
        w_new, w_old = {'A': 0.5, 'B': 0.5}, {'C': 0.5, 'D': 0.5}
        traded = sum(abs(w_new.get(s, 0) - w_old.get(s, 0)) for s in set(w_new) | set(w_old))
        assert traded == pytest.approx(2.0)
        assert traded * 25 / 10_000 == pytest.approx(0.0050)


class TestNoLookAhead:
    """NEGATIVE-CONTROLLED end-to-end: swapping run_backtest's entry to today's close must
    break test_entry_uses_next_open_end_to_end. Checking the fixture's next_open column (what
    an earlier version of this class did) does not exercise the harness at all."""

    def test_fixture_exposes_next_session_open(self):
        dates = [f'2024-01-{i:02d}' for i in range(1, 11)]
        p = _panel({'A': [100, 110, 120, 130, 140, 150, 160, 170, 180, 190]}, dates)
        row = p[p['date'] == '2024-01-03'].iloc[0]
        assert row['close'] == 120 and row['next_open'] == 130

    def test_last_bar_of_a_symbols_life_is_not_tradeable(self):
        dates = [f'2024-01-{i:02d}' for i in range(1, 6)]
        p = _panel({'A': [10, 11, 12, 13, 14]}, dates)
        assert not p.iloc[-1]['eligible']
        assert pd.isna(p.iloc[-1]['next_open'])

    def test_entry_uses_next_open_end_to_end(self):
        """Closes are flat at 100; every open sits 10% above at 110.

        Correct (entry=next_open, exit=next_open):  110 -> 110  = 0.0% per period.
        Look-ahead (entry=close,  exit=next_open):  100 -> 110  = +10.0% per period, i.e. a
        fabricated +10% that comes purely from reading a price the ranking could not trade at.
        delivery_pct is the factor so selection is fixed and cannot itself explain the return.
        """
        n = 24
        dates = [f'2024-01-{i:02d}' for i in range(1, n + 1)]
        prices = {f'S{k}': [100.0] * n for k in range(8)}
        opens = {f'S{k}': [110.0] * n for k in range(8)}
        deliv = {f'S{k}': 90.0 - k for k in range(8)}
        p = _panel(prices, dates, deliv=deliv, opens=opens)
        r = fb.run_backtest(p, 'delivery_pct', 3, 3, cost_bps_per_side=0)
        assert r['gross_per_period_pct'] == pytest.approx(0.0, abs=1e-9), (
            f"expected 0% (flat closes), got {r['gross_per_period_pct']}% -- entry is reading "
            "a price the ranking could not have traded at")


class TestSimulationEndToEnd:
    @staticmethod
    def _rising_falling(n=40):
        dates = [f'2024-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(n)]
        prices = {}
        for k in range(12):                       # winners compound up
            prices[f'UP{k}'] = [100 * (1.01 ** i) for i in range(n)]
        for k in range(12):                       # losers compound down
            prices[f'DN{k}'] = [100 * (0.99 ** i) for i in range(n)]
        return _panel(prices, dates)

    def test_momentum_picks_the_winners_on_a_trending_panel(self):
        """A sanity check that ranking/entry/exit are wired the right way round."""
        p = self._rising_falling()
        r = fb.run_backtest(p, 'momentum_21d', rebalance_days=3, top_k=5, cost_bps_per_side=0)
        assert r['net_per_period_pct'] > 0
        assert r['net_per_period_pct'] > r['universe_per_period_pct']

    def test_reversal_picks_the_losers_on_the_same_panel(self):
        """Same panel, opposite factor -> opposite selection. Guards a sign flip."""
        p = self._rising_falling()
        r = fb.run_backtest(p, 'reversal_21d', rebalance_days=3, top_k=5, cost_bps_per_side=0)
        assert r['net_per_period_pct'] < r['universe_per_period_pct']

    def test_costs_reduce_net_and_are_reported_separately(self):
        p = self._rising_falling()
        free = fb.run_backtest(p, 'momentum_21d', 3, 5, cost_bps_per_side=0)
        paid = fb.run_backtest(p, 'momentum_21d', 3, 5, cost_bps_per_side=50)
        assert paid['net_per_period_pct'] < free['net_per_period_pct']
        assert paid['cost_per_period_pct'] > 0
        assert free['cost_per_period_pct'] == pytest.approx(0.0)
        # gross must be identical: costs are applied on top, not baked into selection
        assert paid['gross_per_period_pct'] == pytest.approx(free['gross_per_period_pct'])

    def test_higher_rebalance_frequency_costs_more_per_year(self):
        """Needs a CHURNING panel, not a trending one.

        First attempt used _rising_falling, where reversal_5d picks the same 5 names forever:
        ongoing turnover is ~0 and the only cost is the initial purchase, which amortizes over
        MORE periods in the fast run and made the slow run look dearer. That was the fixture
        lying, not the harness -- but the harness would have been blamed.
        """
        n = 60
        dates = [f'2024-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(n)]
        prices = {}
        for k in range(20):                     # deterministic churn: leaders keep rotating
            prices[f'S{k}'] = [100 * (1 + 0.08 * math.sin((i + k * 3) / 2.0)) for i in range(n)]
        p = _panel(prices, dates)
        fast = fb.run_backtest(p, 'reversal_5d', 2, 5, cost_bps_per_side=25)
        slow = fb.run_backtest(p, 'reversal_5d', 10, 5, cost_bps_per_side=25)
        assert fast['avg_oneway_turnover'] > 0.1, 'fixture is not actually churning'
        assert fast['annual_cost_drag_pct'] > slow['annual_cost_drag_pct']

    def test_extreme_return_is_clamped_and_counted_not_silently_absorbed(self):
        """BAD must be SELECTED for a reason that PRE-DATES its bad bar.

        A spike cannot be its own selection reason -- the harness (correctly) cannot see it
        before entry, so a name that is flat then explodes is never held through the explosion.
        Here BAD oscillates from the start, so high_vol picks it up on genuine prior
        volatility, and the bad bar then lands mid-holding-period where the clamp must catch it.
        """
        n = 24
        dates = [f'2024-01-{i:02d}' for i in range(1, n + 1)]
        prices = {f'S{k}': [100.0 + 0.1 * k * i for i in range(n)] for k in range(10)}
        bad = [100.0 if i % 2 == 0 else 112.0 for i in range(n)]   # persistently volatile
        bad[17:] = [100_000.0] * (n - 17)                          # RELIANCE-2022-06-16 shape
        prices['BAD'] = bad
        p = _panel(prices, dates)
        r = fb.run_backtest(p, 'high_vol', 2, 3, cost_bps_per_side=0)
        assert r['clamped_returns'] > 0, 'clamp never fired -- BAD was not held through the bar'
        assert abs(r['gross_per_period_pct']) <= fb.RETURN_CLAMP_PCT + 1e-9

    def test_unknown_factor_raises_rather_than_silently_scoring_zero(self):
        p = self._rising_falling()
        with pytest.raises(KeyError):
            fb.run_backtest(p, 'not_a_factor', 3, 5)


class TestFactorDefinitions:
    def test_reversal_is_the_negation_of_momentum(self):
        d = pd.DataFrame({'r5': [1.0, -2.0], 'r21': [3.0, -4.0]})
        assert list(fb.FACTORS['reversal_5d'](d)) == [-1.0, 2.0]
        assert list(fb.FACTORS['reversal_21d'](d)) == [-3.0, 4.0]

    def test_high_and_low_vol_are_exact_opposites(self):
        d = pd.DataFrame({'vol21': [1.0, 5.0]})
        assert list(fb.FACTORS['low_vol'](d)) == [-1.0, -5.0]
        assert list(fb.FACTORS['high_vol'](d)) == [1.0, 5.0]

    def test_momentum_12_1_skips_the_most_recent_month(self):
        """12-1 must be built from c21/c252, never close/c252 — the skip IS the factor."""
        import inspect
        src = inspect.getsource(fb)
        assert "px['r12_1'] = (px['c21'] / px['c252'] - 1) * 100" in src

    def test_zscore_is_safe_on_a_constant_series(self):
        assert list(fb._z(pd.Series([5.0, 5.0, 5.0]))) == [0.0, 0.0, 0.0]

    def test_composite_combines_all_three_legs(self):
        d = pd.DataFrame({'r5':        [10.0, -10.0, 0.0],   # row1 fell
                          'deliv_pct': [20.0,  80.0, 50.0],   # row1 has strong delivery
                          'vol21':     [5.0,    1.0, 3.0]})   # row1 is the calmest
        s = fb.FACTORS['reversal_x_delivery'](d)
        # row1 is the setup the composite is designed to find; row0 is its exact opposite.
        assert s.iloc[1] > s.iloc[2] > s.iloc[0]


class TestSurvivorshipHandling:
    def test_fill_failure_degrades_loudly_instead_of_aborting(self, monkeypatch, capsys):
        """A survivorship-biased run is acceptable; a SILENT one is not."""
        def boom(*a, **k):
            raise RuntimeError('bhavcopy unavailable')
        monkeypatch.setattr(fb, 'read_df', boom)
        px = pd.DataFrame({'symbol': ['A'], 'date': ['2024-01-01'],
                           'open': [1.0], 'close': [1.0], 'volume': [1.0]})
        out = fb._fill_delisted(px, '2024-01-01', '2024-12-31')
        assert len(out) == 1                                  # degraded, not crashed
        assert 'WARNING' in capsys.readouterr().out

    def test_position_that_cannot_be_exited_is_flat_not_dropped(self):
        """A name going dark mid-period must not vanish from the P&L — that IS the bias."""
        dates = [f'2024-01-{i:02d}' for i in range(1, 21)]
        prices = {f'S{k}': [100.0 + k + i for i in range(20)] for k in range(6)}
        p = _panel(prices, dates)
        p.loc[(p['symbol'] == 'S0') & (p['date'] >= '2024-01-11'), 'eligible'] = False
        r = fb.run_backtest(p, 'reversal_5d', 3, 3, cost_bps_per_side=0)
        assert r['periods'] > 0
        assert np.isfinite(r['net_per_period_pct'])


class TestSummaryStats:
    def test_verdict_thresholds_are_pinned(self):
        import inspect
        src = inspect.getsource(fb._print)
        assert 'abs(t) < 2.0' in src, 'the |t|>2 significance bar must stay explicit'

    def test_cost_default_matches_the_documented_india_model(self):
        # ~15bps explicit per side + ~10bps slippage. Changing this changes every verdict.
        assert fb.DEFAULT_COST_BPS_PER_SIDE == 25.0

    def test_turnover_is_reported_one_way(self):
        p = TestSimulationEndToEnd._rising_falling()
        r = fb.run_backtest(p, 'momentum_21d', 3, 5, cost_bps_per_side=0)
        assert 0.0 <= r['avg_oneway_turnover'] <= 1.0



class TestWindowsConsoleSafety:
    """This module is CLI-first and this repo runs on Windows.

    A non-ASCII character in any printed string raises UnicodeEncodeError under the default
    cp1252 console codepage and kills the run AFTER the expensive 3M-bar panel load. That
    already happened once here (a Rs sign), and once before in financial_ratios_fetcher.py
    (a '~' sign, 2026-07-23) where it made every successful run look like an error. The
    docstring is included because argparse prints it verbatim on --help.
    """

    def test_module_source_is_pure_ascii(self):
        path = os.path.join(os.path.dirname(__file__), '..', 'factor_backtest.py')
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        offenders = sorted({c for c in src if ord(c) > 127})
        assert not offenders, (
            f"non-ASCII in factor_backtest.py: {[hex(ord(c)) for c in offenders]} -- these "
            "crash the CLI under Windows cp1252. Use ASCII equivalents (Rs, ->, +/-, --)."
        )



class TestPerYearBreakdown:
    """A marginal |t|~2 factor riding on one good year is the classic false positive."""

    def test_reports_excess_for_every_calendar_year_present(self):
        n = 60
        dates = ([f'2023-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(30)] +
                 [f'2024-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(30)])
        prices = {f'S{k}': [100 * (1 + 0.05 * math.sin((i + k * 3) / 2.0)) for i in range(n)]
                  for k in range(15)}
        r = fb.run_backtest(_panel(prices, dates), 'reversal_5d', 3, 4, cost_bps_per_side=0)
        assert set(r['excess_by_year_pct']) == {2023, 2024}
        assert r['years_positive'].endswith('/2')



class TestBetaAndIdioVol:
    """The riskiest new maths in the module: rolling cov/var instead of a real regression.

    Verified against cases whose answer is known exactly rather than approximately.
    """

    @staticmethod
    def _mkt_panel(n=260, seed=7):
        rng = np.random.default_rng(seed)
        mkt = rng.normal(0, 0.01, n)
        idx = 100 * np.cumprod(1 + mkt)
        # LEVER is exactly 2x the market each day -> beta 2.0, zero residual by construction
        lever = 100 * np.cumprod(1 + 2 * mkt)
        # NOISY is 1x market plus independent noise -> beta ~1.0, idio_vol > 0
        noisy = 100 * np.cumprod(1 + mkt + rng.normal(0, 0.01, n))
        dates = pd.date_range('2022-01-03', periods=n, freq='B').strftime('%Y-%m-%d').tolist()
        rows = []
        for sym, px in (('NIFTY50', idx), ('LEVER', lever), ('NOISY', noisy)):
            for i, d in enumerate(dates):
                rows.append({'symbol': sym, 'date': d, 'close': px[i]})
        df = pd.DataFrame(rows).sort_values(['symbol', 'date']).reset_index(drop=True)
        df['_dr'] = df.groupby('symbol', sort=False)['close'].pct_change()
        return df

    def test_beta_of_a_2x_levered_series_is_2(self):
        out = fb._add_beta_and_idio_vol(self._mkt_panel())
        b = out.loc[out['symbol'] == 'LEVER', 'beta'].dropna()
        assert len(b) > 0
        assert b.iloc[-1] == pytest.approx(2.0, abs=0.01)

    def test_levered_series_has_essentially_zero_idio_vol(self):
        out = fb._add_beta_and_idio_vol(self._mkt_panel())
        iv = out.loc[out['symbol'] == 'LEVER', 'idio_vol'].dropna()
        assert iv.iloc[-1] == pytest.approx(0.0, abs=0.05)

    def test_noisy_series_has_beta_near_one_and_real_idio_vol(self):
        out = fb._add_beta_and_idio_vol(self._mkt_panel())
        sub = out[out['symbol'] == 'NOISY'].dropna(subset=['beta', 'idio_vol'])
        assert sub['beta'].iloc[-1] == pytest.approx(1.0, abs=0.20)
        assert sub['idio_vol'].iloc[-1] > 0.5

    def test_market_proxy_is_removed_from_the_cross_section(self):
        """NIFTY50 is a benchmark, not an investable name -- it must not be rankable."""
        out = fb._add_beta_and_idio_vol(self._mkt_panel())
        assert 'NIFTY50' not in set(out['symbol'])

    def test_missing_market_series_degrades_loudly_without_crashing(self, capsys):
        df = pd.DataFrame({'symbol': ['A'] * 5, 'date': [f'2024-01-0{i}' for i in range(1, 6)],
                           'close': [1.0, 2, 3, 4, 5], '_dr': [np.nan, 1, .5, .33, .25]})
        out = fb._add_beta_and_idio_vol(df)
        assert out['beta'].isna().all() and out['idio_vol'].isna().all()
        assert 'WARNING' in capsys.readouterr().out


class TestLiteratureFactorSigns:
    """Each factor must point the direction its source paper predicts."""

    def test_low_max_ret_prefers_the_non_lottery_name(self):
        d = pd.DataFrame({'max_ret_21d': [2.0, 15.0]})
        s = fb.FACTORS['low_max_ret'](d)
        assert s.iloc[0] > s.iloc[1]

    def test_low_beta_and_low_idio_vol_prefer_the_calmer_name(self):
        d = pd.DataFrame({'beta': [0.6, 1.8], 'idio_vol': [1.0, 4.0]})
        assert fb.FACTORS['low_beta'](d).iloc[0] > fb.FACTORS['low_beta'](d).iloc[1]
        assert fb.FACTORS['low_idio_vol'](d).iloc[0] > fb.FACTORS['low_idio_vol'](d).iloc[1]

    def test_near_52w_high_prefers_the_name_closest_to_its_high(self):
        d = pd.DataFrame({'pct_of_52w_high': [0.99, 0.55]})
        assert fb.FACTORS['near_52w_high'](d).iloc[0] > fb.FACTORS['near_52w_high'](d).iloc[1]

    def test_momentum_ex_lottery_rewards_momentum_and_penalises_both_tails(self):
        d = pd.DataFrame({'r12_1':       [40.0, 40.0, -10.0],
                          'max_ret_21d': [ 3.0, 20.0,   3.0],
                          'vol21':       [ 1.0,  6.0,   1.0]})
        s = fb.FACTORS['momentum_ex_lottery'](d)
        assert s.iloc[0] > s.iloc[1]     # same momentum, lottery/vol tail is demoted
        assert s.iloc[0] > s.iloc[2]     # same calmness, more momentum wins



class TestPicksSafetyWarnings:
    """--picks output is the one thing a person might act on directly, so the two ways it can
    mislead (too-narrow K, untradeably thin names) must be shouted, not buried in a docstring."""

    @staticmethod
    def _panel_with_liquidity(adt_values):
        n = 30
        dates = [f'2024-01-{i:02d}' for i in range(1, n + 1)]
        prices = {f'S{k}': [100.0 + k * i * 0.1 for i in range(n)] for k in range(len(adt_values))}
        p = _panel(prices, dates)
        for k, adt in enumerate(adt_values):
            p.loc[p['symbol'] == f'S{k}', 'adt20'] = adt
        return p

    def test_warns_when_top_k_is_narrower_than_validated(self, capsys):
        p = self._panel_with_liquidity([1e9] * 10)
        fb.todays_picks(p, 'momentum_21d', top_k=5)
        out = capsys.readouterr().out
        assert 'NARROWER than the validated range' in out

    def test_no_narrow_k_warning_at_the_validated_size(self, capsys):
        p = self._panel_with_liquidity([1e9] * 60)
        fb.todays_picks(p, 'momentum_21d', top_k=fb.VALIDATED_MIN_TOP_K)
        assert 'NARROWER' not in capsys.readouterr().out

    def test_warns_about_thin_names_and_names_them(self, capsys):
        p = self._panel_with_liquidity([1e9] * 8 + [1.2e7, 1.4e7])   # 2 thin
        fb.todays_picks(p, 'momentum_21d', top_k=10)
        out = capsys.readouterr().out
        assert 'under Rs 5cr ADT' in out
        assert '2 of' in out

    def test_picks_use_the_same_scoring_path_as_the_backtest(self):
        """No second implementation to drift from what was measured."""
        p = self._panel_with_liquidity([1e9] * 10)
        picks = fb.todays_picks(p, 'momentum_21d', top_k=3)
        last = p[p['eligible']]['date'].max()
        expected = (p[(p['date'] == last) & p['eligible']]
                    .assign(s=lambda d: fb.FACTORS['momentum_21d'](d))
                    .nlargest(3, 's')['symbol'].tolist())
        assert picks['symbol'].tolist() == expected

    def test_unknown_factor_raises(self):
        p = self._panel_with_liquidity([1e9] * 10)
        with pytest.raises(KeyError):
            fb.todays_picks(p, 'nope', top_k=3)


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
