"""
Tests for PerformanceTracker.compute_metrics -- the max-drawdown overflow found live
2026-08-29 (ml-weekly-retrain's performance_tracker(15) step: "RuntimeWarning: overflow
encountered in accumulate" from numpy's cumprod). No DB needed: compute_metrics is a pure
function over pandas Series.
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from performance_tracker import PerformanceTracker


def _series(returns, outcomes=None):
    r = pd.Series(returns, dtype=float)
    if outcomes is None:
        outcomes = ['WIN' if x > 0 else 'LOSS' for x in returns]
    return r, pd.Series(outcomes)


class TestMaxDrawdownOverflow:
    # Realistic reproduction of the live incident: NOT one absurd outlier (a single ×1280
    # multiplier is nowhere near float64's ~1.8e308 ceiling on its own) but many thousands of
    # signals -- 84,529 in the run that actually triggered this -- each compounded sequentially
    # as if they were one continuous equity curve. Even a modest, entirely non-pathological
    # +2%-average return overflows once compounded across that many rows: (1.02)^20000 alone
    # is already far past float64's range. That is the deeper bug clip() alone can't fully
    # cover for a large enough group -- the isfinite() guard is what actually makes this safe.
    N_LARGE = 84_529  # matches the actual row count from the incident (performance_tracker(5))

    def test_large_row_count_does_not_overflow_to_inf_or_nan(self):
        rng = np.random.default_rng(42)
        returns = rng.normal(loc=2.0, scale=3.0, size=self.N_LARGE)  # modest +2% average
        r, o = _series(returns)
        metrics = PerformanceTracker.compute_metrics(r, o, horizon_days=5)
        assert metrics
        assert metrics['max_drawdown_pct'] is None or np.isfinite(metrics['max_drawdown_pct'])

    def test_negative_control_unclipped_cumprod_over_the_same_shape_does_overflow(self):
        # Pins the actual failure mode this fix addresses, independent of compute_metrics: the
        # SAME shape of input, run through the old unguarded computation, DOES overflow. If this
        # assertion ever stops holding, the scenario above has stopped being a real regression
        # test for anything.
        rng = np.random.default_rng(42)
        returns = pd.Series(rng.normal(loc=2.0, scale=3.0, size=self.N_LARGE))
        cum_ret = (1 + returns / 100).cumprod()
        assert np.isinf(cum_ret.iloc[-1])

    def test_ordinary_returns_give_a_sane_finite_drawdown(self):
        returns = [2.0, -1.0, 3.0, -4.0, 1.0, -2.0, 5.0, -3.0]
        r, o = _series(returns)
        metrics = PerformanceTracker.compute_metrics(r, o, horizon_days=5)
        assert metrics['max_drawdown_pct'] is not None
        assert -100.0 <= metrics['max_drawdown_pct'] <= 0.0

    def test_dates_reorder_the_drawdown_path_deterministically(self):
        # Same signals, same dates, two different ROW orders -- must give the identical
        # max_drawdown once `dates` orders them chronologically (the whole point of threading
        # dates through: the result should not depend on arbitrary DataFrame row order).
        returns = [3.0, -5.0, 2.0, -1.0, 4.0]
        dates = pd.Series(pd.to_datetime(
            ['2026-01-05', '2026-01-01', '2026-01-04', '2026-01-02', '2026-01-03']))
        r, o = _series(returns)

        forward = PerformanceTracker.compute_metrics(r, o, horizon_days=5, dates=dates)

        shuffled_idx = [4, 0, 3, 1, 2]
        r2 = r.iloc[shuffled_idx].reset_index(drop=True)
        o2 = o.iloc[shuffled_idx].reset_index(drop=True)
        d2 = dates.iloc[shuffled_idx].reset_index(drop=True)
        shuffled = PerformanceTracker.compute_metrics(r2, o2, horizon_days=5, dates=d2)

        assert forward['max_drawdown_pct'] == pytest.approx(shuffled['max_drawdown_pct'])

    def test_no_dates_falls_back_to_index_order_without_crashing(self):
        returns = [1.0, -2.0, 3.0]
        r, o = _series(returns)
        metrics = PerformanceTracker.compute_metrics(r, o, horizon_days=5)
        assert metrics['max_drawdown_pct'] is not None


class TestProfitFactorZeroLosses:
    """2026-08-29: a small, all-winning segment (e.g. a 7-signal 100%-win-rate bucket) divided
    by an epsilon (1e-9) stand-in for "zero losses," producing values like 58,981,090,726.84 --
    seen live in this session's own performance_tracker.py re-run. There is no real upper bound
    on profit factor when nothing lost money; report None (NULL), not a fabricated ratio."""

    def test_all_wins_reports_none_not_a_fabricated_ratio(self):
        returns = [5.0, 3.0, 7.0, 2.0, 4.0, 6.0, 1.0]  # all positive, mirrors the live case
        r, o = _series(returns)
        metrics = PerformanceTracker.compute_metrics(r, o, horizon_days=5)
        assert metrics['profit_factor'] is None

    def test_mixed_wins_and_losses_gives_a_real_ratio(self):
        returns = [5.0, -2.0, 3.0, -1.0]
        r, o = _series(returns)
        metrics = PerformanceTracker.compute_metrics(r, o, horizon_days=5)
        # compute_metrics rounds to 4dp before returning; compare against the same rounding.
        assert metrics['profit_factor'] == pytest.approx(round(8.0 / 3.0, 4))
