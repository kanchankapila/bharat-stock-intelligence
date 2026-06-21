"""
Tests for market_breadth — market internals computed from our own stock_ohlcv universe.
Pure-function coverage of compute_breadth (no DB). Windows are parameterised so the
fixtures stay tiny (real defaults are 200/20/252 trading days).
"""

import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from market_breadth import compute_breadth


def _wide(rows: dict, dates) -> pd.DataFrame:
    """rows = {symbol: [closes...]} → dates×symbols wide frame."""
    return pd.DataFrame(rows, index=list(dates))


class TestComputeBreadth:
    def test_pct_above_200dma_fraction(self):
        # 5 symbols, 4 days, sma_window=3. On the last day 3 of 5 sit above their 3-day SMA.
        dates = ["d0", "d1", "d2", "d3"]
        rows = {
            "A": [1, 2, 3, 4],   # close 4 > SMA(2,3,4)=3   above
            "B": [1, 2, 3, 5],   # close 5 > SMA(2,3,5)=3.3 above
            "C": [1, 2, 3, 6],   # close 6 > SMA(2,3,6)=3.6 above
            "D": [6, 5, 4, 2],   # close 2 < SMA(5,4,2)=3.6 below
            "E": [6, 5, 4, 1],   # close 1 < SMA(5,4,1)=3.3 below
        }
        out = compute_breadth(_wide(rows, dates), sma_window=3, high_window=2,
                              hl_window=3, min_universe=3)
        assert out.loc["d3", "pct_above_200dma"] == pytest.approx(3 / 5)

    def test_adv_decline_ratio(self):
        # On d3, 4 symbols advance vs prior close, 1 declines → ratio 4/(4+1).
        dates = ["d0", "d1", "d2", "d3"]
        rows = {
            "A": [1, 1, 1, 2],   # +1 advance
            "B": [1, 1, 1, 2],   # +1 advance
            "C": [1, 1, 1, 2],   # +1 advance
            "D": [1, 1, 1, 2],   # +1 advance
            "E": [5, 5, 5, 4],   # -1 decline
        }
        out = compute_breadth(_wide(rows, dates), sma_window=2, high_window=2,
                              hl_window=2, min_universe=3)
        assert out.loc["d3", "adv_decline_ratio"] == pytest.approx(4 / 5)

    def test_pct_at_20d_high(self):
        # high_window=2. On d3 a symbol whose close is the max of the last 2 days is "at high".
        dates = ["d0", "d1", "d2", "d3"]
        rows = {
            "A": [1, 2, 3, 9],   # 9 == rolling-2 max  at-high
            "B": [1, 2, 3, 9],   # at-high
            "C": [9, 8, 7, 6],   # 6 < max(7,6)=7      not at-high
            "D": [9, 8, 7, 6],   # not at-high
            "E": [9, 8, 7, 6],   # not at-high
        }
        out = compute_breadth(_wide(rows, dates), sma_window=2, high_window=2,
                              hl_window=2, min_universe=3)
        assert out.loc["d3", "pct_at_20d_high"] == pytest.approx(2 / 5)

    def test_net_highs_lows_signed_and_bounded(self):
        # hl_window=3. On the last day: 2 names at a fresh 3-day high, 1 at a fresh low.
        dates = ["d0", "d1", "d2", "d3"]
        rows = {
            "A": [1, 2, 3, 4],   # 4 == max(2,3,4)  new high
            "B": [1, 2, 3, 4],   # new high
            "C": [4, 3, 2, 1],   # 1 == min(3,2,1)  new low
            "D": [2, 2, 2, 2],   # flat: 2 == both max and min → counts as both, nets 0
            "E": [2, 2, 2, 2],   # flat
        }
        out = compute_breadth(_wide(rows, dates), sma_window=2, high_window=2,
                              hl_window=3, min_universe=3)
        val = out.loc["d3", "net_highs_lows"]
        # highs: A,B,D,E (D/E flat hit max) = 4 ; lows: C,D,E = 3 ; net = (4-3)/5
        assert -1.0 <= val <= 1.0
        assert val == pytest.approx((4 - 3) / 5)

    def test_thin_universe_is_dropped(self):
        # Universe of 2 < min_universe=3 → that day's breadth is NaN (too thin to be meaningful).
        dates = ["d0", "d1", "d2", "d3"]
        rows = {"A": [1, 2, 3, 4], "B": [4, 3, 2, 1]}
        out = compute_breadth(_wide(rows, dates), sma_window=2, high_window=2,
                              hl_window=2, min_universe=3)
        assert out.loc["d3"].isna().all()

    def test_empty_input(self):
        out = compute_breadth(pd.DataFrame(), sma_window=3, high_window=2,
                              hl_window=3, min_universe=3)
        assert out.empty
        assert list(out.columns) == [
            "pct_above_200dma", "adv_decline_ratio", "pct_at_20d_high", "net_highs_lows",
        ]

    def test_output_columns_and_index(self):
        dates = ["d0", "d1", "d2", "d3", "d4"]
        rng = np.random.default_rng(0)
        rows = {f"S{i}": list(100 + rng.standard_normal(5).cumsum()) for i in range(6)}
        out = compute_breadth(_wide(rows, dates), sma_window=2, high_window=2,
                              hl_window=3, min_universe=3)
        assert list(out.columns) == [
            "pct_above_200dma", "adv_decline_ratio", "pct_at_20d_high", "net_highs_lows",
        ]
        assert out.index.name == "date"
