import numpy as np
import pandas as pd
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def test_NEGATIVE_CONTROL_pct_rank_produces_varying_ranks_on_distinct_values():
    """Live-caught 2026-08-17: every one of quant_scores' 2,424 symbols came back with the
    exact same mf_composite_score=49.0 -- zero variance across the whole universe, despite the
    underlying input columns (return_1m, piotroski_f_score, sharpe_ratio, etc.) being well
    populated (2000+/2424). Root cause: `series.map(ranked)` looked up each of series's VALUES
    as a key into ranked's INDEX (symbols), which a raw factor value never matches, so every
    entry fell through to the `.fillna(50.0)` default. This is the exact scenario: 5 distinct,
    fully-populated values -- no NaN at all -- and the pre-fix code still returns all-50.0."""
    from multi_factor_scorer import _pct_rank
    s = pd.Series([10.0, 25.0, 5.0, 40.0, 15.0], index=['A', 'B', 'C', 'D', 'E'])
    result = _pct_rank(s, higher_is_better=True)
    assert not (result == 50.0).all(), (
        "every value collapsed to the neutral default -- this is the live-caught bug, "
        "series.map(ranked) doing a value-lookup instead of an index-reindex"
    )
    # Highest raw value should rank highest when higher_is_better=True.
    assert result['D'] == 100.0
    assert result['C'] == 20.0
    assert result['D'] > result['B'] > result['E'] > result['A'] > result['C']


def test_pct_rank_lower_is_better_inverts_correctly():
    from multi_factor_scorer import _pct_rank
    s = pd.Series([10.0, 25.0, 5.0, 40.0, 15.0], index=['A', 'B', 'C', 'D', 'E'])
    result = _pct_rank(s, higher_is_better=False)
    # Lowest raw value (C=5.0) should rank highest when lower is better (e.g. debt/equity).
    assert result['C'] == 100.0
    assert result['D'] == 20.0


def test_pct_rank_missing_values_fall_back_to_neutral_50():
    from multi_factor_scorer import _pct_rank
    s = pd.Series([10.0, np.nan, 5.0, 40.0, np.nan], index=['A', 'B', 'C', 'D', 'E'])
    result = _pct_rank(s, higher_is_better=True)
    assert result['B'] == 50.0
    assert result['E'] == 50.0
    # The populated ones must still differ from each other and from the neutral fallback.
    assert result['D'] != result['A'] != result['C']
    assert result['D'] == 100.0


def test_pct_rank_all_nan_returns_all_nan_not_neutral():
    """An entirely-missing factor across the whole universe should read as NaN (unknown), not
    silently as neutral-50 -- the caller decides what to do with a fully-dead column."""
    from multi_factor_scorer import _pct_rank
    s = pd.Series([np.nan, np.nan, np.nan], index=['A', 'B', 'C'])
    result = _pct_rank(s, higher_is_better=True)
    assert result.isna().all()


def test_pct_rank_ties_get_averaged_rank():
    from multi_factor_scorer import _pct_rank
    s = pd.Series([10.0, 10.0, 30.0], index=['A', 'B', 'C'])
    result = _pct_rank(s, higher_is_better=True)
    assert result['A'] == result['B']
    assert result['C'] > result['A']


def test_build_quality_produces_varying_scores_across_symbols():
    """Integration-level check on one factor builder, using the real _build_quality (not
    reimplemented) with realistic multi-symbol input -- the composite bug this test file exists
    for was invisible at the unit level (_pct_rank in isolation) until composed the way run()
    actually calls it, so this pins the composed behaviour too."""
    from multi_factor_scorer import _build_quality
    df = pd.DataFrame({
        'piotroski_f_score': [8, 3, 6, 5, 2],
        'return_on_equity':  [22.0, 5.0, 15.0, 12.0, 3.0],
        'debt_to_equity':    [0.2, 1.8, 0.6, 0.9, 2.5],
    }, index=['A', 'B', 'C', 'D', 'E'])
    result = _build_quality(df)
    assert result.nunique() > 1, "quality scores must vary across symbols with genuinely different fundamentals"
    assert result['A'] > result['B'], "A has the best F-score/ROE/D-E across the board"
