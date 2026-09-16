"""Pins densify_feature_matrix.ffill_and_ages (polars) to the pandas semantics it replaced.

Why this exists: the conversion is a performance change on a job that writes
technical_signals, so the only thing that makes it safe is that the OUTPUT is unchanged.
The reference below is the exact pandas code that used to live in run() -- per-symbol
groupby/ffill with a limit, and a per-row loop for the staleness age.

Note the reference is deliberately the *superseded implementation*, not a hand-derived
expectation: recurring-bugs.md warns that a test which reimplements the logic under test
passes against the unfixed source. Here the pandas version IS the specification, so
comparing against it is the point -- and the test calls the real ffill_and_ages() rather
than a copy of it.

The NaN-vs-null case is the one that matters: polars' forward_fill() propagates over
nulls only, so a float column carrying NaN (which is what pandas hands over) fills
NOTHING unless converted first. test_fills_across_gaps is the negative control for that
-- drop the fill_nan(None) in ffill_and_ages and it fails.
"""
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from densify_feature_matrix import MAX_FILL_AGE_DAYS, ffill_and_ages


def _pandas_reference(df, cols):
    """The implementation that shipped before the polars conversion, verbatim."""
    filled = df.groupby("symbol", group_keys=False)[cols].ffill(limit=MAX_FILL_AGE_DAYS)
    had_any = df[cols].notna().any(axis=1)
    ages = []
    for _, g in df.assign(_has=had_any).groupby("symbol", sort=False):
        age, cur = [], None
        for has_val in g["_has"].values:
            if has_val:
                cur = 0
            elif cur is not None:
                cur += 1
            age.append(cur)
        ages.extend(age)
    return filled, ages


def _panel():
    """Two symbols, interleaved gaps, a leading gap, and a symbol that is entirely null."""
    rows = [
        # symbol, date, a, b
        ("AAA", "2026-01-01", None, None),   # leading gap -> age stays None
        ("AAA", "2026-01-02", 1.0, None),
        ("AAA", "2026-01-03", None, 5.0),
        ("AAA", "2026-01-04", None, None),
        ("AAA", "2026-01-05", 2.0, None),
        ("BBB", "2026-01-01", 9.0, 1.0),
        ("BBB", "2026-01-02", None, None),
        ("BBB", "2026-01-03", None, None),
        ("CCC", "2026-01-01", None, None),   # never observed at all
        ("CCC", "2026-01-02", None, None),
    ]
    df = pd.DataFrame(rows, columns=["symbol", "date", "a", "b"])
    for c in ("a", "b"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.sort_values(["symbol", "date"])


COLS = ["a", "b"]


def test_matches_the_pandas_implementation_it_replaced():
    df = _panel()
    filled, ages = ffill_and_ages(df, COLS)
    ref_filled, ref_ages = _pandas_reference(df, COLS)

    for c in COLS:
        pd.testing.assert_series_equal(
            filled[c].astype("float64").reset_index(drop=True),
            ref_filled[c].astype("float64").reset_index(drop=True),
            check_names=False,
        )
    assert [None if a is None else int(a) for a in ages] == ref_ages


def test_fills_across_gaps():
    """Negative control for the NaN-is-not-null trap: without fill_nan(None) in
    ffill_and_ages, polars fills nothing and every assertion below fails."""
    df = _panel()
    filled, _ = ffill_and_ages(df, COLS)
    a = filled["a"].tolist()
    # AAA rows are index 0..4: None, 1.0, then 1.0 carried across the two gaps, then 2.0
    assert a[1] == 1.0
    assert a[2] == 1.0, "value was not carried forward -- forward_fill saw NaN, not null"
    assert a[3] == 1.0
    assert a[4] == 2.0


def test_never_fills_backwards_or_across_symbols():
    df = _panel()
    filled, _ = ffill_and_ages(df, COLS)
    # AAA's first row precedes any observation -> must stay null, never back-filled
    assert pd.isna(filled["a"].iloc[0])
    # CCC has no observation at all in either column
    ccc = filled.iloc[8:10]
    assert ccc["a"].isna().all() and ccc["b"].isna().all()
    # BBB's 9.0 must not leak into CCC
    assert pd.isna(filled["a"].iloc[8])


def test_age_is_none_until_first_observation_then_counts_rows():
    df = _panel()
    _, ages = ffill_and_ages(df, COLS)
    assert ages[0] is None          # AAA before any value
    assert ages[1] == 0             # AAA first observation
    assert ages[3] == 1             # one row after the 2026-01-03 observation
    assert ages[5] == 0             # BBB first row is an observation
    assert ages[7] == 2             # BBB two rows past its only observation
    assert ages[8] is None and ages[9] is None   # CCC never observed


def test_respects_max_fill_age_days():
    """A gap longer than MAX_FILL_AGE_DAYS must stop being carried."""
    n = MAX_FILL_AGE_DAYS + 5
    rows = [("AAA", "d%04d" % i, 7.0 if i == 0 else None) for i in range(n)]
    df = pd.DataFrame(rows, columns=["symbol", "date", "a"])
    df["a"] = pd.to_numeric(df["a"], errors="coerce")
    filled, _ = ffill_and_ages(df, ["a"])
    vals = filled["a"].tolist()
    assert vals[MAX_FILL_AGE_DAYS] == 7.0, "should still be carried at the limit"
    assert pd.isna(vals[MAX_FILL_AGE_DAYS + 1]), "must stop carrying past the limit"
