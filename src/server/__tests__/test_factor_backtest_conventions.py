"""Missing-exit symmetry + signal-vs-backtest eligibility (2026-08-10 trading-logic review).

Synthetic panels only -- these pin conventions, not returns, so they must not depend on the
production DB. Negative-controlled: reverting each source change fails the named test.
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import factor_backtest as fb  # noqa: E402


def _panel(n_dates=70, n_syms=12, delist=None, delist_from=None):
    """Flat prices so every real return is exactly 0% -- any non-zero result is the
    convention under test, not price noise."""
    dates = pd.date_range('2024-01-01', periods=n_dates, freq='B').normalize()
    rows = []
    for i in range(n_syms):
        sym = f'SYM{i:02d}'
        for j, d in enumerate(dates):
            if delist and sym in delist and j >= delist_from:
                continue
            rows.append({'symbol': sym, 'date': d, 'open': 100.0, 'close': 100.0,
                         'adt20': 5e8, 'r5': 0.0, 'r21': float(i), 'r63': 0.0,
                         'r12_1': float(i), 'vol21': 1.0, 'deliv_pct': 50.0})
    px = pd.DataFrame(rows).sort_values(['symbol', 'date']).reset_index(drop=True)
    px['next_open'] = px.groupby('symbol')['open'].shift(-1)
    px['signal_eligible'] = px['adt20'] >= 1e7
    px['eligible'] = px['signal_eligible'] & px['next_open'].notna() & (px['next_open'] > 0)
    return px


class TestEligibilitySplit:
    def test_newest_bar_is_signal_eligible_but_not_backtest_eligible(self):
        px = _panel()
        last = px['date'].max()
        newest = px[px['date'] == last]
        assert newest['signal_eligible'].all()
        assert not newest['eligible'].any()   # next_open is NaN by construction

    def test_todays_picks_uses_the_newest_session(self):
        """The bug: `eligible` selection could only ever return the PREVIOUS session, whose
        entry open had already traded before the post-close job even ran."""
        px = _panel()
        picks = fb.todays_picks(px, 'momentum_12_1', top_k=5)
        assert picks['date'].iloc[0] == px['date'].max()

    def test_entry_state_is_pending_on_the_newest_session(self):
        px = _panel()
        status, session = fb.picks_entry_state(px, px['date'].max())
        assert status == 'pending_next_open'
        assert session is None

    def test_entry_state_is_expired_for_an_older_session(self):
        px = _panel()
        older = sorted(px['date'].unique())[-3]
        status, session = fb.picks_entry_state(px, older)
        assert status == 'entry_passed'
        assert session is not None

    def test_payload_carries_entry_state(self):
        px = _panel()
        picks = fb.todays_picks(px, 'momentum_12_1', top_k=5)
        status, session = fb.picks_entry_state(px, picks['date'].iloc[0])
        payload = fb.factor_picks_payload(picks, 'momentum_12_1', status, session)
        assert payload['entryStatus'] == 'pending_next_open'
        assert payload['entrySession'] is None


class TestMissingExitSymmetry:
    def test_flat_panel_produces_flat_result(self):
        """Control: with no delistings the convention must be inert."""
        r = fb.run_backtest(_panel(), 'momentum_12_1', rebalance_days=5, top_k=3)
        assert r['missing_exits'] == 0
        assert r['gross_per_period_pct'] == pytest.approx(0.0, abs=1e-9)
        assert r['universe_per_period_pct'] == pytest.approx(0.0, abs=1e-9)

    def test_a_delisting_hits_strategy_and_benchmark_alike(self):
        """The bug: the strategy booked the delisted name at 0% while the benchmark DROPPED
        it -- two conventions for one event, and the strategy got the flattering one. The
        delisted name is the top-ranked one (highest r12_1), so it is definitely held."""
        px = _panel(delist={'SYM11'}, delist_from=30)
        r = fb.run_backtest(px, 'momentum_12_1', rebalance_days=5, top_k=3,
                            cost_bps_per_side=0.0)
        assert r['missing_exits'] > 0
        assert r['net_per_period_pct'] < 0        # no longer silently flat
        assert r['universe_per_period_pct'] < 0   # benchmark took the same hit

    def test_the_convention_is_not_clamped_away(self):
        """RETURN_CLAMP_PCT is a bad-bar guard for OBSERVED prices; clamping a -100% write-off
        to -50% would quietly restore the optimism."""
        assert abs(fb.MISSING_EXIT_PCT) > fb.RETURN_CLAMP_PCT
        px = _panel(delist={'SYM11'}, delist_from=30)
        deep = fb.run_backtest(px, 'momentum_12_1', rebalance_days=5, top_k=3,
                               cost_bps_per_side=0.0, missing_exit_pct=-100.0)
        mild = fb.run_backtest(px, 'momentum_12_1', rebalance_days=5, top_k=3,
                               cost_bps_per_side=0.0, missing_exit_pct=-10.0)
        assert deep['net_per_period_pct'] < mild['net_per_period_pct']

    def test_summary_reports_the_assumption(self):
        r = fb.run_backtest(_panel(), 'momentum_12_1', rebalance_days=5, top_k=3)
        assert r['missing_exit_pct'] == fb.MISSING_EXIT_PCT
        assert 'missing_exits' in r


class TestProvisionalFactorsAreDeclared:
    def test_value_factors_are_flagged(self):
        assert fb.PROVISIONAL_FACTORS
        assert fb.PROVISIONAL_FACTORS <= set(fb.FACTORS)
        assert 'value_book_to_price' in fb.PROVISIONAL_FACTORS
        assert 'momentum_12_1' not in fb.PROVISIONAL_FACTORS


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-q']))
