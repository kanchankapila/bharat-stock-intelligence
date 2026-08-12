"""Alive-but-unpriced must NOT be written off as delisted (2026-08-12).

Synthetic panels only -- these pin the accounting convention, not returns, so they must not
depend on the production DB. Flat prices everywhere, so every real return is exactly 0% and any
non-zero universe figure is the bug under test rather than price noise.

The bug: run_backtest wrote off at MISSING_EXIT_PCT (-100%) any name lacking an exit bar on the
exit date, conflating "no bar on this one date" with "delisted". Measured on the real panel,
0.039% of eligible names per session are unpriced-but-alive and ZERO are genuinely gone, so the
write-off fired on 100% false positives -- ~9.9pp/yr of phantom drag on the benchmark, which
flipped universe_annualised_pct to -16.77%/yr at --rebalance 1.

Negative-controlled: reverting the last_alive branch fails test_universe_ignores_alive_but_unpriced.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import factor_backtest as fb  # noqa: E402


def _panel(n_dates=24, n_syms=8, drop_bar_on=None, delist_from=None):
    """Flat 100.0 prices. drop_bar_on = {sym: [date_idx,...]} removes THAT bar only (symbol
    trades again after). delist_from = {sym: idx} removes every bar from idx onward."""
    drop_bar_on = drop_bar_on or {}
    delist_from = delist_from or {}
    dates = pd.date_range('2024-01-01', periods=n_dates, freq='B').strftime('%Y-%m-%d')
    rows = []
    for i in range(n_syms):
        sym = f'SYM{i:02d}'
        for j, d in enumerate(dates):
            if j in drop_bar_on.get(sym, []):
                continue
            if sym in delist_from and j >= delist_from[sym]:
                continue
            rows.append({'symbol': sym, 'date': d, 'open': 100.0, 'close': 100.0,
                         'adt20': 5e8, 'r5': 0.0, 'r21': float(i), 'r63': 0.0,
                         'r12_1': float(i), 'vol21': 1.0, 'deliv_pct': 50.0})
    px = pd.DataFrame(rows).sort_values(['symbol', 'date']).reset_index(drop=True)
    px['next_open'] = px.groupby('symbol')['open'].shift(-1)
    px['signal_eligible'] = px['adt20'] >= 1e7
    px['eligible'] = px['signal_eligible'] & px['next_open'].notna() & (px['next_open'] > 0)
    return px


class TestIndexLastAlive:
    def test_is_keyed_on_next_open_not_close(self):
        """A symbol's FINAL bar has a close but no next_open -- it can no longer be sold, so it
        must not count as alive. Keying this map on close instead would suppress the write-off
        on exactly the names that genuinely delisted."""
        px = _panel(n_syms=3)
        la = fb.index_last_alive(px)
        all_dates = sorted(px['date'].unique())
        assert la['SYM00'] == all_dates[-2]        # not [-1]: the last bar is unexitable
        assert la['SYM00'] < px['date'].max()

    def test_a_delisted_symbol_stops_earlier_than_a_surviving_one(self):
        px = _panel(n_syms=3, delist_from={'SYM01': 10})
        la = fb.index_last_alive(px)
        assert la['SYM01'] < la['SYM00']

    def test_a_one_day_gap_does_not_shorten_a_symbols_life(self):
        """The whole distinction: a missing mid-series bar is not a delisting."""
        px = _panel(n_syms=3, drop_bar_on={'SYM01': [10]})
        la = fb.index_last_alive(px)
        assert la['SYM01'] == la['SYM00']


class TestUniverseAccounting:
    def _uni(self, px, **kw):
        r = fb.run_backtest(px, 'momentum_21d', rebalance_days=1, top_k=2, cost_bps_per_side=0.0, **kw)
        return r['universe_per_period_pct']

    def test_flat_panel_universe_is_exactly_zero(self):
        """Baseline: with no gaps at all, flat prices must give a 0% universe."""
        assert self._uni(_panel()) == 0.0

    def test_universe_ignores_alive_but_unpriced(self):
        """THE regression. One symbol misses a single bar mid-series and trades on afterwards.

        Before the fix that name took -100% in the universe leg for that period, dragging the
        benchmark negative on a panel where nothing actually moved.
        """
        px = _panel(drop_bar_on={'SYM03': [10]})
        assert self._uni(px) == 0.0

    def test_genuine_delisting_is_still_written_off(self):
        """The guard must not become 'never write anything off' -- that is the survivorship
        hole the -100% convention exists to close."""
        px = _panel(delist_from={'SYM03': 12})
        assert self._uni(px) < 0.0

    def test_write_off_still_uses_the_configured_missing_exit_pct(self):
        px = _panel(delist_from={'SYM03': 12})
        harsh = self._uni(px, missing_exit_pct=-100.0)
        mild = self._uni(px, missing_exit_pct=-10.0)
        assert harsh < mild < 0.0


class TestStrategyLegSymmetry:
    def test_strategy_leg_applies_the_same_rule_as_the_universe_leg(self):
        """A held name that is merely unpriced must not book a -100% loss either -- and dropping
        it must renormalise, not silently park its weight in cash at 0%."""
        px = _panel(drop_bar_on={'SYM07': [10]})     # SYM07 has the top r21, so it IS held
        r = fb.run_backtest(px, 'momentum_21d', rebalance_days=1, top_k=2,
                            cost_bps_per_side=0.0)
        assert r['gross_per_period_pct'] == 0.0
        assert r['net_excess_vs_universe_pct'] == 0.0

    def test_renormalisation_does_not_invent_return_on_a_flat_panel(self):
        """Renormalising scales gross by wt_total/wt_used; on a flat panel that must still be 0,
        not a scaled-up non-zero."""
        px = _panel(drop_bar_on={'SYM07': [10], 'SYM06': [10]})
        r = fb.run_backtest(px, 'momentum_21d', rebalance_days=1, top_k=2, cost_bps_per_side=0.0)
        assert r['gross_per_period_pct'] == 0.0
