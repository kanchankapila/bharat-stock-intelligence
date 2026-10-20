import numpy as np
import pandas as pd
import pytest

import deep_panel_score as dps
from deep_panel_score import (
    EXCLUDED_COLUMNS, FACTOR_GROUPS, LEAK_CORR_LIMIT, LeakDetected, PINNED_COLUMNS, assert_no_label_leak,
    composite_score, same_day_contemporaneity, shuffled_control, winsorise_returns, zscore_by_date,
)

# The 47 deep_feature_columns() returned over 2021-01-01..2022-01-01 (Task 6's final set).
C47 = """ret_1d ret_5d ret_15d ret_21d ret_63d sma20 sma50 ema8 ema21 dist_sma20_pct rsi_14 rsi_28 macd
macd_signal macd_hist stoch_k stoch_d cci williams_r bb_upper bb_lower bb_width bb_pct hist_vol_21d hist_vol_63d
volume_ratio_20d volume_ratio_5d obv obv_slope vwap vwap_dist_pct mtf_alignment_score fii_3d_net fii_10d_net
delivery_pct trailing_pe rev_growth eps_growth earnings_yield nifty_pe advance_decline_ratio nifty_ret_5d
nifty_ret_21d insider_buy_pct_90d sector_ret_5d sector_ret_21d price_to_book""".split()


def _panel(n_dates=6, n_sym=60, seed=0, **extra):
    rng = np.random.default_rng(seed)
    dates = [f"2024-03-{d:02d}" for d in range(1, n_dates + 1)]
    df = pd.DataFrame({"date": np.repeat(dates, n_sym), "symbol": np.tile([f"S{i}" for i in range(n_sym)], n_dates)})
    for name, scale in extra.items():
        df[name] = rng.normal(size=len(df)) * scale
    return df


def test_winsorise_clips_a_lone_extreme_to_an_observed_value():
    # The trap: linear-interpolated quantile(0.99) lands ~1% of the way toward the outlier (1.04 here)
    # and "clips" nothing. 'higher'/'lower' picks the 99th OBSERVED value.
    s = pd.Series(list(np.linspace(-0.05, 0.05, 99)) + [99.0])
    out = winsorise_returns(s)
    assert out.max() == pytest.approx(0.05)
    assert out.mean() < 0.01
    assert out.isin(s.iloc[:99]).all()


def test_winsorise_keeps_index_and_nan():
    s = pd.Series([1.0, np.nan, 2.0, np.inf, 3.0], index=list("abcde"))
    out = winsorise_returns(s, pct=0.0)
    assert list(out.index) == list("abcde") and np.isnan(out["b"]) and np.isnan(out["d"])


def test_zscore_standardises_each_date_independently():
    df = _panel(x=1.0)
    df.loc[df.date == "2024-03-02", "x"] *= 1000  # a date on a different scale
    z = zscore_by_date(df, ["x"])
    g = z["x"].groupby(df["date"])
    assert np.allclose(g.mean(), 0, atol=1e-9) and np.allclose(g.std(), 1, atol=1e-9)


def test_zscore_lone_outlier_cannot_dominate_a_date():
    df = _panel(n_dates=1, n_sym=100, x=1.0)
    df.loc[0, "x"] = 1e6
    assert zscore_by_date(df, ["x"])["x"].abs().max() < 4  # unwinsorised it is ~9.9


def test_zscore_constant_within_date_is_nan_not_zero():
    df = _panel(x=1.0)
    df["m"] = df["date"].map({d: i for i, d in enumerate(sorted(df.date.unique()))}).astype(float)
    assert zscore_by_date(df, ["m"])["m"].isna().all()


def test_every_deep_column_is_grouped_or_explicitly_excluded_exactly_once():
    grouped = [c for cols in FACTOR_GROUPS.values() for c in cols]
    assert len(grouped) == len(set(grouped))
    assert set(grouped) & set(EXCLUDED_COLUMNS) == set()
    assert set(grouped) | set(EXCLUDED_COLUMNS) == set(C47)
    assert set(FACTOR_GROUPS) == {"momentum", "value", "quality", "flow", "volatility"}


def test_price_level_columns_are_not_in_any_group():
    for c in ("sma20", "sma50", "ema8", "ema21", "bb_upper", "bb_lower", "vwap"):
        assert c in EXCLUDED_COLUMNS and all(c not in v for v in FACTOR_GROUPS.values())


def test_unnamed_column_raises_instead_of_being_dropped():
    df = _panel(ret_5d=1.0, brand_new_col=1.0)
    with pytest.raises(ValueError, match="brand_new_col"):
        composite_score(df, ["ret_5d", "brand_new_col"])


def test_label_column_is_not_a_scorable_input():
    df = _panel(ret_5d=1.0, target_ret_5d=1.0)
    with pytest.raises(ValueError, match="target_ret_5d"):
        composite_score(df, ["ret_5d", "target_ret_5d"])


def test_composite_is_equal_weight_within_then_across_groups():
    df = _panel(a1=1.0, a2=1.0, b1=1.0)
    groups = {"A": ("a1", "a2"), "B": ("b1",)}
    z = zscore_by_date(df, ["a1", "a2", "b1"])
    expected = ((z.a1 + z.a2) / 2 + z.b1) / 2  # B's one column weighs as much as A's two together
    got = composite_score(df, ["a1", "a2", "b1"], groups)
    assert np.allclose(got, expected)
    assert got.index.equals(df.index)


def test_composite_ignores_the_target_column():
    df = _panel(ret_5d=1.0, rsi_14=1.0)
    base = composite_score(df, ["ret_5d", "rsi_14"])
    df["target_ret_5d"] = np.random.default_rng(1).normal(size=len(df))
    assert np.allclose(composite_score(df, ["ret_5d", "rsi_14"]), base)


def test_cheap_is_high_and_nonpositive_multiples_are_not_cheap():
    df = _panel(n_dates=1, n_sym=50)
    df["trailing_pe"] = np.linspace(5, 60, 50)
    df.loc[0, "trailing_pe"] = -3.0  # loss-making: a negative P/E must not rank as the cheapest stock
    s = composite_score(df, ["trailing_pe"])
    assert np.isnan(s.iloc[0])
    assert s.iloc[1] > s.iloc[-1]  # lower P/E scores higher


def test_low_volatility_scores_higher():
    df = _panel(n_dates=1, n_sym=50)
    df["hist_vol_21d"] = np.linspace(10, 60, 50)
    s = composite_score(df, ["hist_vol_21d"])
    assert s.iloc[0] > s.iloc[-1]


def test_pinned_columns_are_the_47_and_match_groups_plus_exclusions():
    assert list(PINNED_COLUMNS) == C47 and len(PINNED_COLUMNS) == 47
    assert {c for v in FACTOR_GROUPS.values() for c in v} | set(EXCLUDED_COLUMNS) == set(PINNED_COLUMNS)


def test_a_column_outside_the_pinned_set_raises():
    df = _panel(ret_5d=1.0, sma200=1.0)  # exists in the 2021-2026 window but not the pinned 47
    with pytest.raises(ValueError, match="sma200"):
        composite_score(df, ["ret_5d", "sma200"])


def test_leak_limit_is_the_published_factor_tell():
    assert LEAK_CORR_LIMIT == 0.15


def test_label_gate_trips_when_the_score_is_the_label():
    # negative control: a score that IS its label (plus a little noise) must not pass
    df = _panel(n_sym=80, target_ret_5d=1.0)
    leaky = df["target_ret_5d"] + np.random.default_rng(2).normal(size=len(df)) * 0.1
    with pytest.raises(LeakDetected):
        assert_no_label_leak(df, leaky, "target_ret_5d")


def test_label_gate_passes_an_independent_score_and_returns_the_float():
    df = _panel(n_sym=200, target_ret_5d=1.0)
    clean = pd.Series(np.random.default_rng(3).normal(size=len(df)), index=df.index)
    r = assert_no_label_leak(df, clean, "target_ret_5d")
    assert isinstance(r, float) and abs(r) < LEAK_CORR_LIMIT


def test_label_gate_cannot_pass_vacuously():
    df = _panel(n_dates=2, n_sym=2, target_ret_5d=1.0)
    with pytest.raises(ValueError):
        assert_no_label_leak(df, pd.Series(range(len(df)), index=df.index), "target_ret_5d")


def test_contemporaneity_is_reported_not_gated():
    df = _panel(n_sym=80, ret_1d=1.0)
    same = same_day_contemporaneity(df, df["ret_1d"].copy())  # corr 1.0 and it must NOT raise
    assert isinstance(same, float) and same == pytest.approx(1.0)


def test_shuffled_control_destroys_a_label_leak_the_gate_catches():
    df = _panel(n_sym=200, target_ret_5d=1.0)
    leaky = df["target_ret_5d"].copy()
    with pytest.raises(LeakDetected):
        assert_no_label_leak(df, leaky, "target_ret_5d")
    assert abs(assert_no_label_leak(df, shuffled_control(df, leaky), "target_ret_5d")) < LEAK_CORR_LIMIT


def test_shuffled_control_permutes_within_each_date_only():
    df = _panel(ret_1d=1.0)
    score = pd.Series(np.random.default_rng(4).normal(size=len(df)) + df["date"].rank(method="dense").to_numpy() * 100,
                      index=df.index)  # per-date offset makes any cross-date move detectable
    ctrl = shuffled_control(df, score)
    for _, idx in df.groupby("date").groups.items():
        assert sorted(ctrl[idx]) == pytest.approx(sorted(score[idx]))
    assert not np.allclose(ctrl, score)
    assert shuffled_control(df, score).equals(ctrl)
    assert not shuffled_control(df, score, seed=1).equals(ctrl)
