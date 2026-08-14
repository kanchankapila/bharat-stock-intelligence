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
from screener_combo_finder import (
    compute_tier1_precursors, _day_level_backtest, search_combinations, _pool_by_concept_tag,
)


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


class TestPoolByConceptTag:
    """Tier 2's concept-tag pooling (screener-combo-predictor SKILL.md, Loop A3). Both
    NiftyTrader's 45 filter_keys and the EOD catalog's ~90 (category, sentiment) columns
    mostly cannot individually clear MIN_SIGNALS on their own -- pooling by the concept a raw
    column's own name expresses is what's supposed to give search_combinations() enough
    observations per cell, the same logic tier 1 already depends on."""

    def test_multiple_raw_columns_expressing_the_same_concept_or_pool_into_one_tag(self):
        """todayGapUP and yesterdayGapUP both decompose to mech_gap. A symbol that fires
        EITHER must read as mech_gap=1 -- this is the entire point of pooling: two 4%-dense
        raw columns becoming one 8%-dense tag column."""
        wide = pd.DataFrame({
            "symbol": ["AAA", "BBB", "CCC"],
            "nt_todayGapUP": [1, 0, 0],
            "nt_yesterdayGapUP": [0, 1, 0],
        })
        tags = _pool_by_concept_tag(
            wide, {"nt_todayGapUP": "todayGapUP", "nt_yesterdayGapUP": "yesterdayGapUP"},
            tag_prefix="ntTag_")
        assert list(tags["ntTag_mech_gap"]) == [1, 1, 0]

    def test_a_name_of_entry_for_a_column_absent_from_wide_is_silently_ignored(self):
        """name_of can legitimately reference a column that isn't in THIS run's wide frame
        (e.g. a filter that matched zero symbols today, so pivot_table never created its
        column) -- must not KeyError on wide[cols]. Fails if the `col not in wide.columns`
        guard is removed: wide["nt_neverFired"] then raises."""
        wide = pd.DataFrame({"symbol": ["AAA"], "nt_todayGapUP": [1]})
        tags = _pool_by_concept_tag(
            wide, {"nt_todayGapUP": "todayGapUP", "nt_neverFired": "todayGapDown"},
            tag_prefix="ntTag_")
        assert list(tags["ntTag_mech_gap"]) == [1]

    def test_a_name_with_no_signal_tags_contributes_no_tag_column(self):
        """A raw column whose name decomposes to nothing (or only descriptive tags) must not
        silently manufacture a tag. Fails if signal_tags stopped excluding descriptive tags."""
        wide = pd.DataFrame({"symbol": ["AAA"], "nt_grouplist": [1]})
        tags = _pool_by_concept_tag(
            wide, {"nt_grouplist": "Adani Group share prices & companies list"}, tag_prefix="ntTag_")
        assert tags.empty or tags.shape[1] == 0

    def test_tag_prefix_distinguishes_niftytrader_from_eod_pools(self):
        """run_tier2 merges the NiftyTrader and EOD wide frames; both pool onto the same
        underlying concept vocabulary (mech_gap, mech_ma_stack, ...). Without distinct
        prefixes the merge would silently collide the two into one ambiguous column instead
        of two tier-distinguishable ones."""
        wide = pd.DataFrame({"symbol": ["AAA"], "raw": [1]})
        nt = _pool_by_concept_tag(wide, {"raw": "todayGapUP"}, tag_prefix="ntTag_")
        eod = _pool_by_concept_tag(wide, {"raw": "Bollinger Band Breakdown"}, tag_prefix="eodTag_")
        assert "ntTag_mech_gap" in nt.columns
        assert "eodTag_mech_bollinger" in eod.columns
        assert set(nt.columns).isdisjoint(eod.columns)