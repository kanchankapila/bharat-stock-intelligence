"""Equal-weight composite score over the deep feature panel, with the same-day leak guard built in.

Pure pandas: takes a panel DataFrame (columns `date`, `symbol`, feature columns), reads and writes nothing.
No fitted weights (Finding #31): every weight is 1/n_columns within a group and 1/n_groups across groups.
"""
import numpy as np
import pandas as pd

# ml-model-bugs.md: published equity factors run IC 0.02-0.05 and an IC above ~0.15 on a price-derived
# factor is the cheapest signature of a leak.
LEAK_CORR_LIMIT = 0.15

# The 47 deep_feature_columns() returns over its default window (2021-01-01..2022-01-01). Pinned on
# purpose: the same statistic must be computed on every date of the panel. A column that only becomes
# available part-way through (the 2021-2026 window yields 56, adding ret_126d, sma200, dist_sma200_pct,
# nifty_vix, us_10y_yield, dxy, crude_ret_5d, gold_ret_5d, sp500_ret_5d) would change the composite's own
# composition over time, so a 2021 score and a 2024 score would not be the same thing.
PINNED_COLUMNS: tuple[str, ...] = (
    "ret_1d", "ret_5d", "ret_15d", "ret_21d", "ret_63d", "sma20", "sma50", "ema8", "ema21", "dist_sma20_pct",
    "rsi_14", "rsi_28", "macd", "macd_signal", "macd_hist", "stoch_k", "stoch_d", "cci", "williams_r",
    "bb_upper", "bb_lower", "bb_width", "bb_pct", "hist_vol_21d", "hist_vol_63d", "volume_ratio_20d",
    "volume_ratio_5d", "obv", "obv_slope", "vwap", "vwap_dist_pct", "mtf_alignment_score", "fii_3d_net",
    "fii_10d_net", "delivery_pct", "trailing_pe", "rev_growth", "eps_growth", "earnings_yield", "nifty_pe",
    "advance_decline_ratio", "nifty_ret_5d", "nifty_ret_21d", "insider_buy_pct_90d", "sector_ret_5d",
    "sector_ret_21d", "price_to_book",
)

# Grouping of the 47 columns deep_feature_columns() returns over 2021-01-01..2022-01-01. A column in
# neither FACTOR_GROUPS nor EXCLUDED_COLUMNS raises (composite_score), it is never silently dropped.
FACTOR_GROUPS: dict[str, tuple[str, ...]] = {
    "momentum": (
        "ret_1d", "ret_5d", "ret_15d", "ret_21d", "ret_63d", "rsi_14", "rsi_28", "macd", "macd_signal",
        "macd_hist", "stoch_k", "stoch_d", "cci", "williams_r", "dist_sma20_pct", "bb_pct",
        "vwap_dist_pct", "mtf_alignment_score", "sector_ret_5d", "sector_ret_21d",
    ),
    "value": ("trailing_pe", "price_to_book", "earnings_yield"),
    "quality": ("rev_growth", "eps_growth"),
    "flow": (
        "delivery_pct", "volume_ratio_20d", "volume_ratio_5d", "obv", "obv_slope", "insider_buy_pct_90d",
    ),
    "volatility": ("hist_vol_21d", "hist_vol_63d", "bb_width"),
}

_PRICE_LEVEL = "raw price level: rank-identical to price by construction (measurement.md duplicate-information census)"
_MARKET_WIDE = "one value per date (market-wide): zero cross-sectional variance, a z-score is undefined"
EXCLUDED_COLUMNS: dict[str, str] = {
    **dict.fromkeys(("sma20", "sma50", "ema8", "ema21", "bb_upper", "bb_lower", "vwap"), _PRICE_LEVEL),
    **dict.fromkeys(
        ("fii_3d_net", "fii_10d_net", "nifty_pe", "advance_decline_ratio", "nifty_ret_5d", "nifty_ret_21d"),
        _MARKET_WIDE,
    ),
}

# A-priori direction, not fitted: cheap and low-risk score high. Everything else: higher raw = higher score.
SIGNS = {"trailing_pe": -1, "price_to_book": -1, "hist_vol_21d": -1, "hist_vol_63d": -1, "bb_width": -1}
# A non-positive multiple means negative/zero earnings or book, which is not "cheap".
_POSITIVE_ONLY = ("trailing_pe", "price_to_book")


class LeakDetected(RuntimeError):
    pass


def winsorise_returns(s: pd.Series, pct: float = 0.01) -> pd.Series:
    s = s.replace([np.inf, -np.inf], np.nan)
    clean = s.dropna()
    if clean.empty:
        return s
    # Observed values moved INWARD. The linear default interpolates toward a lone outlier and clips
    # almost nothing (ml-model-bugs.md; trade_journal.winsorize hit the same trap).
    lo = clean.quantile(pct, interpolation="higher")
    hi = clean.quantile(1 - pct, interpolation="lower")
    return s.clip(lo, hi)


def zscore_by_date(panel: pd.DataFrame, columns, pct: float = 0.01) -> pd.DataFrame:
    def z(x: pd.Series) -> pd.Series:
        w = winsorise_returns(x, pct)
        sd = w.std()
        return (w - w.mean()) / sd if sd and np.isfinite(sd) else w * np.nan

    return panel[list(columns)].groupby(panel["date"]).transform(z)


def composite_score(panel: pd.DataFrame, columns=PINNED_COLUMNS, groups=FACTOR_GROUPS) -> pd.Series:
    cols = list(columns)
    grouped = {c for g in groups.values() for c in g}
    unnamed = [c for c in cols if c not in grouped and c not in EXCLUDED_COLUMNS]
    if unnamed:
        raise ValueError(f"columns named by no factor group and not excluded: {unnamed}")
    used = [c for c in cols if c in grouped]
    x = panel[used].copy()
    for c in _POSITIVE_ONLY:
        if c in x:
            x[c] = x[c].where(x[c] > 0)
    z = zscore_by_date(pd.concat([x, panel[["date"]]], axis=1), used)
    for c in used:
        z[c] *= SIGNS.get(c, 1)
    # skipna means a row scored on one group only is still scored; ponytail: add a min-groups floor if the grader needs one.
    per_group = pd.concat(
        {g: z[[c for c in members if c in z]].mean(axis=1, skipna=True)
         for g, members in groups.items() if any(c in z for c in members)},
        axis=1,
    )
    return per_group.mean(axis=1, skipna=True)


def _per_date_spearman(a: pd.Series, b: pd.Series, dates: pd.Series) -> float:
    df = pd.DataFrame({"a": a, "b": b, "d": dates}).dropna()
    df["a"] = df.groupby("d")["a"].rank()
    df["b"] = df.groupby("d")["b"].rank()
    cors = [g["a"].corr(g["b"]) for _, g in df.groupby("d") if len(g) >= 3]
    cors = [c for c in cors if np.isfinite(c)]
    if not cors:
        raise ValueError("no date has >= 3 names with both values: leak check cannot run")
    return float(np.mean(cors))


def assert_no_label_leak(panel, score, label_col, limit: float = LEAK_CORR_LIMIT) -> float:
    """Mean per-date Spearman of the score with the LABEL it will be graded on; raises at |r| >= limit.
    The +3.6%/day net, t=+14.9 fabrication was a selection variable that WAS the traded return (corr 1.0).
    A score that correlates 0.9 with its own label is that failure; this is where it is reachable."""
    r = _per_date_spearman(score, panel[label_col], panel["date"])
    if abs(r) >= limit:
        raise LeakDetected(f"score correlates {r:+.3f} with its label {label_col} (limit {limit})")
    return r


def same_day_contemporaneity(panel, score, same_day_return_col="ret_1d") -> float:
    """Diagnostic, NOT a gate: mean per-date Spearman of the score with the day's own trailing return.
    Every feature is known at close[t] and the labels are close.pct_change(1).shift(-2) and
    pct_change(5).shift(-6), so the traded window starts at close[t+1] and does not overlap the day that
    produced ret_1d. Measured on feature_store, March 2024 (36,036 rows): corr(ret_1d, target_ret_1d) =
    -0.0015, corr(ret_1d, target_ret_5d) = +0.0133. A momentum-flavoured composite agrees with the day that
    already happened (+0.255 Mar 2024, +0.205 Jun 2022) by construction; that is not leakage. Printed
    beside each verdict so a reader can see the composite is momentum-flavoured."""
    return _per_date_spearman(score, panel[same_day_return_col], panel["date"])


def shuffled_control(panel, score, seed=20261021) -> pd.Series:
    """Permute the score within each date: cross-sectional shape survives, the symbol mapping is destroyed."""
    if not score.index.equals(panel.index):
        raise ValueError("score must be indexed like panel")
    rng = np.random.default_rng(seed)
    vals = score.to_numpy()
    out = vals.copy()
    for pos in panel.groupby("date").indices.values():
        out[pos] = vals[rng.permutation(pos)]
    return pd.Series(out, index=score.index, name=score.name)
