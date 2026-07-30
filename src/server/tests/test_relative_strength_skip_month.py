"""Regression tests for Finding #25 (2026-07-28 full-stack audit): relative_strength.py's
63-day momentum was plain trailing return (wide.pct_change(63)) with no skip-month
treatment -- Jegadeesh-Titman (1993) cross-sectional momentum specifically excludes the
most recent month because short-term reversal is a distinct, opposite-signed effect.
_windowed_return() now computes the 63-day window as return from (t-63) to (t-21) instead
of (t-63) to (t); the 21-day window is intentionally left as plain trailing return (too
short to sensibly skip a month from).
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from relative_strength import _windowed_return, SKIP_MONTH_DAYS, build_rs_features


class TestWindowedReturn:
    def test_21d_window_is_unchanged_plain_trailing_return(self):
        prices = pd.Series(np.linspace(100, 200, 100))
        wide = pd.DataFrame({"A": prices})
        result = _windowed_return(wide, 21)
        expected = wide.pct_change(21)
        pd.testing.assert_frame_equal(result, expected)

    def test_63d_window_excludes_the_most_recent_21_days(self):
        prices = pd.Series(np.arange(100, dtype=float) + 100.0)
        wide = pd.DataFrame({"A": prices})
        result = _windowed_return(wide, 63)

        t = 90
        expected = (prices.iloc[t - SKIP_MONTH_DAYS] - prices.iloc[t - 63]) / prices.iloc[t - 63]
        assert result["A"].iloc[t] == pytest.approx(expected)

    def test_a_sharp_recent_reversal_does_not_flip_the_skip_month_signal(self):
        """The whole point: a stock that ran up for 2 months then reversed hard in the
        most recent month should still show POSITIVE skip-month momentum (the reversal is
        excluded), while the naive (non-skip) version would show it dragged down or negative."""
        n = 100
        prices = np.full(n, 100.0)
        # Strong uptrend from day 0 to day 79 (100 -> 180)
        prices[:80] = np.linspace(100, 180, 80)
        # Sharp reversal in the most recent 20 days (180 -> 140)
        prices[80:] = np.linspace(180, 140, 20)
        wide = pd.DataFrame({"A": prices})

        t = 99
        naive = wide.pct_change(63)["A"].iloc[t]
        skip_month = _windowed_return(wide, 63)["A"].iloc[t]

        assert skip_month > 0, "skip-month momentum must stay positive despite the recent reversal"
        assert skip_month > naive, "skip-month version must be less contaminated by the recent reversal than naive"


class TestBuildRsFeaturesUsesSkipMonth:
    def test_rs_rank_63d_reflects_skip_month_not_naive_trailing_return(self):
        """End-to-end: a stock with a strong 2-month run followed by a 1-month reversal
        should still rank near the TOP on rs_rank_63d (skip-month), even though its naive
        trailing 63-day return would be much smaller (or negative)."""
        dates = pd.date_range("2026-01-01", periods=100, freq="B")
        symbols_data = []
        # Build a small universe: one stock (LEADER) with the run-up-then-reversal shape,
        # the rest flat, so LEADER's skip-month rank should be unambiguously high.
        leader_prices = np.full(100, 100.0)
        leader_prices[:80] = np.linspace(100, 180, 80)
        leader_prices[80:] = np.linspace(180, 140, 20)

        for i in range(25):
            sym = f"S{i}"
            if sym == "S0":
                prices = leader_prices
            else:
                prices = np.full(100, 100.0) + np.random.default_rng(i).normal(0, 0.5, 100).cumsum() * 0.01
            for d, p in zip(dates, prices):
                symbols_data.append({"symbol": sym, "date": d, "close": p})

        ohlcv = pd.DataFrame(symbols_data)
        feats = build_rs_features(ohlcv)

        last_date = dates[-1]
        leader_row = feats[(feats.symbol == "S0") & (feats.date == last_date)]
        assert not leader_row.empty
        assert leader_row["rs_rank_63d"].iloc[0] > 0.8, \
            "a stock with a strong run then a recent reversal should still rank near the top via skip-month momentum"
