"""External-score merge (2026-09-27): the path that makes the ranker cost-testable.

Why this file exists: `unified_recommendations` carries two time columns and they mean
different things. `computed_at` is the session the ranking is FOR (the entry session);
`generated_at` is when the run produced it, one session earlier. `factor_backtest.py` buys
the NEXT session's open after the date a factor is scored on, so merging on the wrong column
lags the strategy by a session and scores a post-close re-run against its own day. Both are
silent -- the run still completes and still prints a plausible number.

Synthetic panels only: no DB, no network. The DB-reading half (`_add_external_scores`) is
covered by its identifier guard plus the pure merge it delegates to.
"""
import inspect
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import factor_backtest as fb  # noqa: E402


def _scores(rows) -> pd.DataFrame:
    """Columns as `_add_external_scores` produces them after its SQL aliasing."""
    return pd.DataFrame(rows, columns=['symbol', '_score_ts', 'external_score'])


def _panel(n_dates: int = 40, n_syms: int = 8) -> pd.DataFrame:
    """Flat 100.0 prices so any non-zero return is the convention under test."""
    dates = pd.date_range('2026-09-01', periods=n_dates, freq='B').normalize()
    rows = []
    for i in range(n_syms):
        for d in dates:
            rows.append({'symbol': f'SYM{i:02d}', 'date': d.strftime('%Y-%m-%d'),
                         'open': 100.0, 'close': 100.0, 'volume': 1e6, 'adt20': 5e8,
                         'deliv_pct': 50.0})
    px = pd.DataFrame(rows).sort_values(['symbol', 'date']).reset_index(drop=True)
    px['next_open'] = px.groupby('symbol')['open'].shift(-1)
    px['signal_eligible'] = True
    px['eligible'] = px['next_open'].notna()
    return px


class TestScoreDateConvention:
    """The trap this whole path exists to avoid."""

    def test_score_lands_on_the_session_it_was_generated_not_the_entry_session(self):
        """A Friday-evening run stamped for Monday's entry must be dated FRIDAY.

        Live shape 2026-09-27: computed_at=2026-09-28, generated_at=2026-09-25 17:00:01Z.
        Dated Friday, this harness buys Monday's open -- the trade the platform actually
        makes. Dated Monday it would buy Tuesday's open, one session late.
        """
        px = _panel()
        sc = _scores([('SYM00', '2026-09-25 17:00:01+00', 9.5)])
        out = fb._merge_external_scores(px, sc)
        got = out.loc[out['external_score'].notna(), 'date'].tolist()
        assert got == ['2026-09-25']

    def test_a_future_stamped_score_never_reaches_its_entry_session(self):
        """No row on the entry session itself -- otherwise the merge is look-ahead by one
        session in the other direction (data the strategy could not have had)."""
        px = _panel()
        sc = _scores([('SYM00', '2026-09-25 17:00:01+00', 9.5)])
        out = fb._merge_external_scores(px, sc)
        row = out[(out['symbol'] == 'SYM00') & (out['date'] == '2026-09-28')]
        assert row['external_score'].isna().all()

    def test_default_timestamp_column_is_generated_at(self):
        """Pins the documented choice. Switching the default to computed_at would triple the
        live panel's apparent size and quietly lag every measured return by a session."""
        sig = inspect.signature(fb._add_external_scores)
        assert sig.parameters['ts_col'].default == 'generated_at'


class TestMergeMechanics:
    def test_timestamp_is_reduced_to_its_utc_date(self):
        px = _panel()
        sc = _scores([('SYM01', '2026-09-03T22:30:00+00:00', 1.0)])
        out = fb._merge_external_scores(px, sc)
        assert out.loc[out['external_score'].notna(), 'date'].tolist() == ['2026-09-03']

    def test_duplicate_stamps_on_one_session_keep_the_latest(self):
        """Two intraday re-runs must not resolve by insertion order."""
        px = _panel()
        sc = _scores([('SYM02', '2026-09-03 05:00:00+00', 1.0),
                      ('SYM02', '2026-09-03 17:00:00+00', 7.0)])
        out = fb._merge_external_scores(px, sc)
        val = out.loc[(out['symbol'] == 'SYM02') & (out['date'] == '2026-09-03'),
                      'external_score'].iloc[0]
        assert val == 7.0

    def test_no_forward_fill_across_sessions(self):
        px = _panel()
        sc = _scores([('SYM03', '2026-09-03 17:00:00+00', 4.0)])
        out = fb._merge_external_scores(px, sc)
        sym = out[out['symbol'] == 'SYM03'].sort_values('date')
        assert sym['external_score'].notna().sum() == 1

    def test_unparseable_timestamps_are_dropped_not_crashed(self):
        px = _panel()
        sc = _scores([('SYM04', 'not-a-timestamp', 3.0),
                      ('SYM04', '2026-09-03 17:00:00+00', 5.0)])
        out = fb._merge_external_scores(px, sc)
        assert out.loc[out['external_score'].notna(), 'external_score'].tolist() == [5.0]

    def test_null_scores_are_not_zero_filled(self):
        """0.0 is a real rank on a centred score; NaN is 'unknown'. Never conflate them."""
        px = _panel()
        sc = pd.DataFrame([('SYM05', '2026-09-03 17:00:00+00', np.nan)],
                          columns=['symbol', '_score_ts', 'external_score'])
        out = fb._merge_external_scores(px, sc)
        assert out['external_score'].isna().all()

    def test_ts_col_parameter_selects_which_timestamp_is_used(self):
        """The trap is controllable: handed `computed_at` explicitly, the merge dates by the
        ENTRY session, which is the wrong-but-documented behaviour the default avoids."""
        px = _panel()
        sc = pd.DataFrame([('SYM06', '2026-09-28', 2.0)],
                          columns=['symbol', 'computed_at', 'external_score'])
        out = fb._merge_external_scores(px, sc, ts_col='computed_at')
        assert out.loc[out['external_score'].notna(), 'date'].tolist() == ['2026-09-28']


class TestTheDbHalfFitsThePureHalf:
    def test_source_timestamp_is_aliased_to_the_column_the_merge_expects(self, monkeypatch):
        """Integration seam: the SQL must rename the source timestamp, or every merge silently
        produces all-NaN (the pure half looks for `_score_ts`)."""
        seen = {}

        def _fake_read_df(sql, params=()):
            seen['sql'] = sql
            return pd.DataFrame([('SYM00', '2026-09-03 17:00:00+00', 5.0)],
                                columns=['symbol', '_score_ts', 'external_score'])

        monkeypatch.setattr(fb, 'read_df', _fake_read_df)
        out = fb._add_external_scores(_panel(), 'unified_recommendations', 'unified_score')
        assert 'generated_at AS _score_ts' in seen['sql']
        assert out.loc[out['external_score'].notna(), 'date'].tolist() == ['2026-09-03']



class TestIdentifierGuard:
    @pytest.mark.parametrize('table,col,ts', [
        ("unified_recommendations; DROP TABLE users", 'unified_score', 'generated_at'),
        ('unified_recommendations', 'unified_score) FROM x --', 'generated_at'),
        ('unified_recommendations', 'unified_score', 'generated_at, (SELECT 1)'),
        ('unified_recommendations', 'unified_score', ''),
    ])
    def test_non_identifier_input_is_refused_before_any_db_read(self, monkeypatch, table, col, ts):
        def _boom(*a, **k):
            raise AssertionError('read_df must not be reached for non-identifier input')

        monkeypatch.setattr(fb, 'read_df', _boom)
        with pytest.raises(ValueError):
            fb._add_external_scores(_panel(), table, col, ts)


class TestAllFactorSelection:
    def test_bare_all_excludes_the_external_factor_that_was_not_loaded(self):
        """`python factor_backtest.py` must not print a fake FAILED line for an optional input."""
        selected = fb._select_factors('all', external_score_loaded=False)
        assert 'external_score' not in selected

    def test_all_includes_external_score_when_the_caller_loaded_it(self):
        selected = fb._select_factors('all', external_score_loaded=True)
        assert 'external_score' in selected


def _priced_panel(rising: str = 'SYM00') -> pd.DataFrame:
    """Flat 100.0 for every symbol except `rising`, which compounds +1% per session, so a
    selection that includes it is visibly different from one that does not."""
    dates = pd.bdate_range('2026-09-01', periods=40)
    rows = []
    for i in range(8):
        sym, px = f'SYM{i:02d}', 100.0
        for d in dates:
            rows.append({'symbol': sym, 'date': d.strftime('%Y-%m-%d'), 'open': px, 'close': px,
                         'volume': 1e6, 'adt20': 5e8, 'deliv_pct': 50.0})
            if sym == rising:
                px *= 1.01
    px = pd.DataFrame(rows).sort_values(['symbol', 'date']).reset_index(drop=True)
    px['next_open'] = px.groupby('symbol')['open'].shift(-1)
    px['signal_eligible'] = True
    px['eligible'] = px['next_open'].notna()
    return px


def _rebalance_dates(px: pd.DataFrame, rebalance: int = 5) -> list:
    """The sessions run_backtest will form portfolios on -- a score only counts if it lands on
    one of these, so tests must derive them from the panel rather than hardcoding dates."""
    return sorted(px.loc[px['eligible'], 'date'].unique())[::rebalance]


class TestThroughTheRealHarness:
    def test_the_score_actually_decides_what_is_held(self):
        """Behavioural, not structural: the same panel must produce a different portfolio when
        the top-scored name changes. A merge that silently landed nothing would make both runs
        identical or raise."""
        px = _priced_panel()
        days = _rebalance_dates(px)
        rows = [(f'SYM{i:02d}', f'{d} 17:00:00+00', float(i)) for d in days for i in range(1, 8)]
        riser = [('SYM00', f'{d} 17:00:00+00', 99.0) for d in days]

        a = fb.run_backtest(fb._merge_external_scores(px, _scores(rows)),
                            'external_score', rebalance_days=5, top_k=2)
        b = fb.run_backtest(fb._merge_external_scores(px, _scores(rows + riser)),
                            'external_score', rebalance_days=5, top_k=2)
        assert a['periods'] > 0 and b['periods'] > 0
        # The riser (+1%/session, ~+5%/period) is only reachable when it carries a score.
        assert a['gross_per_period_pct'] == pytest.approx(0.0, abs=0.01)
        assert b['gross_per_period_pct'] > 2.0

    def test_an_unscored_name_is_not_selectable(self):
        """SYM00 has no score in this run, and the panel would otherwise hand it the top spot."""
        px = _priced_panel()
        rows = [(f'SYM{i:02d}', f'{d} 17:00:00+00', float(i))
                for d in _rebalance_dates(px) for i in range(1, 8)]
        scored = fb._merge_external_scores(px, _scores(rows))
        assert scored.loc[scored['symbol'] == 'SYM00', 'external_score'].isna().all()
        r = fb.run_backtest(scored, 'external_score', rebalance_days=5, top_k=2)
        assert r['gross_per_period_pct'] == pytest.approx(0.0, abs=0.01)

    def test_an_unscored_session_produces_no_period_rather_than_a_fabricated_one(self):
        """A score that lands on a session the harness does not rebalance on must NOT be
        carried onto the next rebalance date (that would be a stale ranking presented as a
        fresh one). Nothing is stamped here, so there is nothing to hold -- the run must say
        so rather than report an arbitrary portfolio."""
        px = _priced_panel()
        midsession = sorted(px.loc[px['eligible'], 'date'].unique())[1]
        rows = [(f'SYM{i:02d}', f'{midsession} 17:00:00+00', float(i)) for i in range(1, 8)]
        scored = fb._merge_external_scores(px, _scores(rows))
        with pytest.raises(RuntimeError, match='no completed rebalance periods'):
            fb.run_backtest(scored, 'external_score', rebalance_days=5, top_k=2)

    def test_factor_is_unusable_without_the_merge(self):
        """Registered but absent -- must fail loudly, not score an all-NaN panel."""
        with pytest.raises(KeyError):
            fb.run_backtest(_priced_panel(), 'external_score', rebalance_days=5, top_k=2)


class TestVerdictPowerGate:
    """Reproduces the 2026-09-27 output that motivated the gate: on the live panel the ranker
    read +1.315%/period, t=4.49 over THREE periods and this file printed "positive and
    significant net of costs -- worth a live paper test"."""

    def _thin_run(self, capsys):
        px = _priced_panel()
        days = _rebalance_dates(px)
        rows = [(f'SYM{i:02d}', f'{d} 17:00:00+00', float(i)) for d in days for i in range(1, 8)]
        # SYM00 is top-scored everywhere, so the portfolio holds the riser and the run is
        # clearly profitable -- which is exactly the case that must still not earn a verdict.
        rows += [('SYM00', f'{d} 17:00:00+00', 99.0) for d in days]
        r = fb.run_backtest(fb._merge_external_scores(px, _scores(rows)),
                            'external_score', rebalance_days=5, top_k=2)
        fb._print(r)
        return capsys.readouterr().out

    def test_a_thin_panel_gets_no_verdict(self, capsys):
        out = self._thin_run(capsys)
        assert 'INSUFFICIENT POWER' in out          # negative control: absent before the gate
        assert 'worth a live paper test' not in out

    def test_the_gate_names_the_floor_it_applied(self, capsys):
        out = self._thin_run(capsys)
        assert str(fb.MIN_PERIODS_FOR_VERDICT) in out
        assert 'turnover' in out                    # still surfaces what IS readable

    def test_a_deep_panel_still_reaches_a_verdict(self, capsys):
        """The gate must not swallow real evidence: 20+ periods over a year still get a verdict."""
        r = {'periods': fb.MIN_PERIODS_FOR_VERDICT, 'years': 1.5, 'benchmark_sane': True,
             'excess_t_stat': 2.5, 'net_excess_vs_universe_pct': 0.4, 'avg_oneway_turnover': 0.3,
             'annual_cost_drag_pct': 3.0, 'factor': 'x', 'long_short': False,
             'rebalance_days': 21, 'top_k': 50, 'cost_bps_per_side': 25, 'missing_exit_pct': -100.0,
             'missing_exits': 0, 'universe_per_period_pct': 1.0, 'gross_per_period_pct': 1.0,
             'cost_per_period_pct': 0.2, 'net_per_period_pct': 0.8, 'universe_annualised_pct': 12.0,
             'pct_periods_beating_universe': 60.0, 'cagr_net_pct': 10.0, 'sharpe_net': 1.1,
             'max_drawdown_pct': -10.0, 'clamped_returns': 0, 'years_positive': '2/3',
             'excess_by_year_pct': {2025: 0.3, 2026: 0.5}, '_periods_df': pd.DataFrame()}
        fb._print(r)
        assert 'worth a live paper test' in capsys.readouterr().out




