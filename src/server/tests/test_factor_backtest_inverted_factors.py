"""Every fs_<col>_inv factor must negate its OWN column (2026-09-26).

Guards the late-binding trap: `{f'fs_{c}_inv': lambda d: -d[c] for c in COLS}` without the
`c=c` default argument closes over the loop variable, so all 25 entries would read the LAST
column -- 24 factors silently measuring atr_pct under 24 different names, with no error and a
plausible-looking backtest for each. That is this repo's "evidence-shaped output" class in
harness form, so it gets a structural check rather than a comment.

Derived from FEATURE_STORE_FACTORS, not a hand-listed allowlist, so a column added there is
covered automatically.
"""
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import factor_backtest as fb  # noqa: E402


def test_every_feature_store_column_has_an_inverted_twin():
    for col in fb.FEATURE_STORE_FACTORS:
        assert f"fs_{col}" in fb.FACTORS
        assert f"fs_{col}_inv" in fb.FACTORS


def test_inverted_factor_negates_its_own_column():
    # Distinct per-column values, so a factor reading the WRONG column is detectable. With the
    # late-binding bug every inv factor returns -[last column], which this catches on the first
    # non-final column instead of passing vacuously.
    df = pd.DataFrame({c: [float(i), float(i) + 0.5]
                       for i, c in enumerate(fb.FEATURE_STORE_FACTORS, start=1)})
    for col in fb.FEATURE_STORE_FACTORS:
        got = list(fb.FACTORS[f"fs_{col}_inv"](df))
        want = [-v for v in df[col]]
        assert got == want, f"fs_{col}_inv read the wrong column: {got} != {want}"


def test_inverted_is_exact_mirror_of_the_plain_factor():
    df = pd.DataFrame({c: [1.0, -2.5, 0.0] for c in fb.FEATURE_STORE_FACTORS})
    for col in fb.FEATURE_STORE_FACTORS:
        plain = fb.FACTORS[f"fs_{col}"](df)
        inv = fb.FACTORS[f"fs_{col}_inv"](df)
        assert list(inv) == [-v for v in plain]


def test_nan_is_preserved_not_coerced():
    """A NaN must stay NaN, never become 0.0 -- a sentinel 0 would rank a name with no data
    mid-pack instead of excluding it (the sentinel-instead-of-NULL class)."""
    df = pd.DataFrame({c: [1.0, float("nan")] for c in fb.FEATURE_STORE_FACTORS})
    out = fb.FACTORS["fs_atr_pct_inv"](df)
    assert out.iloc[0] == -1.0
    assert pd.isna(out.iloc[1])
