"""compute_matches: the pure combo-matching core of live_capitulation_screener.py.

Reuses screener_combo_finder.py's validated thresholds (GAP_THRESHOLD, TOP_PCT, the
has_range guard) rather than redefining them, so this locks in that the live intraday
version reproduces the SAME triple condition that measurement.md's tier-1 backtest found
significant (spread +0.5258%/day, t=3.58, p=0.0004): gap_down AND open_eq_low AND top_loser,
all required together -- not any one alone.
"""
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from live_capitulation_screener import compute_matches
from screener_combo_finder import GAP_THRESHOLD, MIN_ADTV, MIN_PRICE


def _row(symbol, day_open, day_low, day_high, last_price, prev_close,
         adtv=MIN_ADTV * 2, day_volume=100_000):
    return {"symbol": symbol, "day_open": day_open, "day_low": day_low, "day_high": day_high,
            "last_price": last_price, "prev_close": prev_close, "adtv": adtv,
            "day_volume": day_volume}


def _flat_universe(n=25, base_price=100.0):
    """n unremarkable, flat-ish rows (~0% move each) so a cross-sectional 'bottom 5%' rank
    is actually meaningful -- TOP_PCT=0.05 needs >=20 names in the universe before anything
    can qualify as the bottom percentile at all."""
    return [
        _row(f"BASE_{i}", day_open=base_price, day_low=base_price * 0.998,
             day_high=base_price * 1.002, last_price=base_price * (1 + i * 1e-5),
             prev_close=base_price)
        for i in range(n)
    ]


class TestAllThreeConditionsRequired:
    def test_gap_down_open_eq_low_and_top_loser_together_matches(self):
        """A textbook capitulation day: gapped down >2%, opened at (and stayed at) the low,
        and is the worst performer in a small universe -- matches HARIOMPIPE's real shape
        live-verified 2026-08-13 (prev_close 392.7, open=low=358.2, gap -8.79%)."""
        rows = [_row("CAPIT", day_open=358.2, day_low=358.2, day_high=374.1, last_price=360.0,
                      prev_close=392.7)] + _flat_universe()
        out = compute_matches(pd.DataFrame(rows))
        assert [m["symbol"] for m in out] == ["CAPIT"]

    def test_gap_down_alone_without_open_eq_low_does_not_match(self):
        """Gapped down hard but bounced well off the low intraday -- not a capitulation
        setup, and the single-filter gap_down result (factor_backtest.py, t<-3) is why this
        must NOT fire alone."""
        rows = [
            _row("BOUNCED", day_open=90.0, day_low=88.0, day_high=95.0, last_price=94.0,
                 prev_close=100.0),
            _row("BASE_A", day_open=50.0, day_low=49.8, day_high=50.2, last_price=50.0,
                 prev_close=50.0),
            _row("BASE_B", day_open=60.0, day_low=59.8, day_high=60.2, last_price=60.0,
                 prev_close=60.0),
        ]
        out = compute_matches(pd.DataFrame(rows))
        assert out == []

    def test_open_eq_low_without_gap_down_does_not_match(self):
        """Opened at the low but didn't actually gap down from yesterday's close."""
        rows = [
            _row("NOGAP", day_open=100.0, day_low=100.0, day_high=104.0, last_price=100.5,
                 prev_close=100.0),
            _row("BASE_A", day_open=50.0, day_low=49.8, day_high=50.2, last_price=50.0,
                 prev_close=50.0),
            _row("BASE_B", day_open=60.0, day_low=59.8, day_high=60.2, last_price=60.0,
                 prev_close=60.0),
        ]
        out = compute_matches(pd.DataFrame(rows))
        assert out == []

    def test_flat_zero_range_day_cannot_satisfy_open_eq_low(self):
        """Same degenerate-range guard as compute_tier1_precursors -- a circuit-locked/no-
        trade day (open==high==low) must not count as 'opened at the low and held'."""
        rows = [
            _row("LOCKED", day_open=50.0, day_low=50.0, day_high=50.0, last_price=45.0,
                 prev_close=51.5),
            _row("BASE_A", day_open=100.0, day_low=99.8, day_high=100.2, last_price=100.0,
                 prev_close=100.0),
            _row("BASE_B", day_open=200.0, day_low=199.8, day_high=200.2, last_price=200.0,
                 prev_close=200.0),
        ]
        out = compute_matches(pd.DataFrame(rows))
        assert out == []


class TestLiquidityAndPriceFloor:
    def test_below_adtv_floor_is_excluded(self):
        rows = [
            _row("ILLIQUID", day_open=90.0, day_low=90.0, day_high=94.0, last_price=90.5,
                 prev_close=100.0, adtv=MIN_ADTV / 2),
            _row("BASE_A", day_open=50.0, day_low=49.8, day_high=50.2, last_price=50.0,
                 prev_close=50.0),
            _row("BASE_B", day_open=60.0, day_low=59.8, day_high=60.2, last_price=60.0,
                 prev_close=60.0),
        ]
        out = compute_matches(pd.DataFrame(rows))
        assert out == []

    def test_below_price_floor_is_excluded(self):
        rows = [
            _row("PENNY", day_open=9.0, day_low=9.0, day_high=9.5, last_price=9.1,
                 prev_close=10.0),
            _row("BASE_A", day_open=50.0, day_low=49.8, day_high=50.2, last_price=50.0,
                 prev_close=50.0),
            _row("BASE_B", day_open=60.0, day_low=59.8, day_high=60.2, last_price=60.0,
                 prev_close=60.0),
        ]
        out = compute_matches(pd.DataFrame(rows))
        assert out == []


def test_empty_input_returns_empty():
    cols = ["symbol", "day_open", "day_low", "day_high", "last_price", "prev_close",
            "adtv", "day_volume"]
    assert compute_matches(pd.DataFrame(columns=cols)) == []
