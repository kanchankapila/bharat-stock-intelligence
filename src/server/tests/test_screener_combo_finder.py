"""
screener_combo_finder.py's first version reported "REAL EDGE" (t=11.17) on
gap_down+open_eq_high+open_eq_low — a logical near-contradiction (a stock cannot both open
at its high AND its low unless the day had zero real range) that turned out to be flagging
circuit-locked/no-trading days, not a genuine "opened strong and held" pattern (median
same-day open->close return on the flagged rows was exactly 0.0, and several sampled rows
were literally flat O=H=L=C). This test locks in the fix: open_eq_high/open_eq_low must
require a real intraday range before firing, so a flat day can never satisfy both at once.

Also covers the day-level backtest's core purpose: it must aggregate to one observation per
day before computing a spread/t-stat, so a filter that persists across many rows for the
same handful of stocks doesn't get treated as a large independent sample (the exact gap
found in live_screener_optimizer.py's own win_rate/avg_return, which has no day-level or
benchmark-relative check at all).
"""
import os
import sys

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from screener_combo_finder import compute_tier1_precursors, _day_level_backtest, search_combinations


def _flat_ohlcv_row(symbol, date, price):
    """A zero-range bar: open == high == low == close (a circuit lock, or simply no trade)."""
    return {"symbol": symbol, "date": date, "open": price, "high": price, "low": price,
            "close": price, "volume": 10_000.0}


def _real_range_row(symbol, date, open_, high, low, close, volume=100_000.0):
    return {"symbol": symbol, "date": date, "open": open_, "high": high, "low": low,
            "close": close, "volume": volume}


class TestOpenEqHighLowDegenerateGuard:
    def test_flat_zero_range_day_flags_neither_open_eq_high_nor_open_eq_low(self):
        rows = [_flat_ohlcv_row("FLAT", "2026-01-01", 100.0),
                _flat_ohlcv_row("FLAT", "2026-01-02", 100.0)]
        ohlcv = pd.DataFrame(rows)
        out = compute_tier1_precursors(ohlcv).set_index(["date", "symbol"])
        row = out.loc[("2026-01-02", "FLAT")]
        assert row["open_eq_high"] == 0
        assert row["open_eq_low"] == 0

    def test_real_range_day_that_genuinely_opened_at_the_low_still_flags(self):
        # Opened at 100, traded up to 106 (6% range), closed at 105 -- never traded below
        # the open: a genuine "opened at the low and held/rallied" day.
        rows = [_real_range_row("STRONG", "2026-01-01", 100.0, 100.0, 100.0, 100.0),
                _real_range_row("STRONG", "2026-01-02", 100.0, 106.0, 100.0, 105.0)]
        ohlcv = pd.DataFrame(rows)
        out = compute_tier1_precursors(ohlcv).set_index(["date", "symbol"])
        row = out.loc[("2026-01-02", "STRONG")]
        assert row["open_eq_low"] == 1
        assert row["open_eq_high"] == 0  # it DID trade above its open, so not open_eq_high

    def test_a_day_can_never_be_flagged_both_open_eq_high_and_open_eq_low_across_a_larger_sample(self):
        """Regression guard for the exact bug this module shipped with once: a genuinely
        random sample of bars must never produce a row where both flags are simultaneously
        true, because that would only be possible on a flat (already-excluded) day."""
        rng = np.random.default_rng(0)
        rows = []
        for i in range(200):
            o = 100 + rng.normal(0, 5)
            spread = abs(rng.normal(0, 2)) + 0.01  # always a nonzero range
            h = o + rng.uniform(0, spread)
            l = o - rng.uniform(0, spread)
            c = rng.uniform(l, h)
            rows.append(_real_range_row(f"SYM{i % 5}", f"2026-01-{(i % 27) + 1:02d}", o, h, l, c))
        out = compute_tier1_precursors(pd.DataFrame(rows))
        both = (out["open_eq_high"] == 1) & (out["open_eq_low"] == 1)
        assert not both.any(), "a row was flagged both open_eq_high and open_eq_low on a real-range day"


class TestDayLevelAggregation:
    def test_backtest_aggregates_to_one_observation_per_day_not_per_row(self):
        """Ten identical, highly-autocorrelated rows on ONE day must count as ONE day of
        evidence, not ten independent samples -- the exact inflation gap this module's
        docstring calls out in live_screener_optimizer.py."""
        rows = []
        for i in range(10):
            rows.append({"date": "2026-01-01", "flag": 1, "oc_ret": 0.05})
        for i in range(10):
            rows.append({"date": f"2026-01-{i+2:02d}", "flag": 0, "oc_ret": 0.0})
        df = pd.DataFrame(rows)
        result = _day_level_backtest(df, df["flag"].astype(bool), cost_pct=0.0)
        # Only ONE day actually has flag=1 rows -> below the MIN_DAYS floor -> None,
        # not a (spurious) ten-sample "finding".
        assert result is None

    def test_search_combinations_respects_min_signal_floor(self):
        df = pd.DataFrame({
            "date": [f"2026-01-{i+1:02d}" for i in range(40)],
            "a": [1] * 40, "oc_ret": [0.01] * 40,
        })
        results = search_combinations(df, ["a"], max_size=1)
        # 40 signals across 40 distinct days clears MIN_DAYS/MIN_SIGNALS -- should be found.
        assert any(r["filters"] == ["a"] for r in results)