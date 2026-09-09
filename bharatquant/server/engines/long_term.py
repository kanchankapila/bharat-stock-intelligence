"""Long-term engine — 3m–1y institutional-grade quality blend.
Scores the SHARED feature frame (assemble.build_full_features) rather than rebuilding.
Factors: trend structure (above SMA200, 1y slope), 63d momentum (light), quality
(fundamentals: ROE, margins, PiOTROSKI, D/E, pledge), valuation percentile.
Mean-reversion-minded: steep 63d strength is de-emphasized.
"""
import numpy as np
import pandas as pd


def add_long_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add long-horizon columns to an already-built daily feature frame."""
    if len(df) == 0:
        return df
    g = df.groupby("symbol", sort=False)
    df["ret_63d"] = g["close"].pct_change(63)
    df["ret_252d"] = g["close"].pct_change(252)
    df["above_sma50"] = (df["close"] > df["sma50"]).astype(int)
    # 1y slope (fraction of price/day), latest-row evaluation
    slopes = {}
    for sym, x in df.groupby("symbol", sort=False):
        x = x.sort_values("date")
        win = x.tail(252)
        if len(win) < 150:
            slopes[sym] = 0.0
            continue
        b = np.polyfit(np.arange(len(win)), win["close"].values, 1)[0]
        slopes[sym] = b / win["close"].iloc[-1]
    df["slope_1y"] = df["symbol"].map(slopes)
    return df


def score(feat: pd.DataFrame) -> pd.DataFrame:
    """Latest-row long-term ranking (feat must already include add_long_features)."""
    if len(feat) == 0:
        return feat
    latest = feat.groupby("symbol", as_index=False).tail(1).copy()
    latest = latest.replace([np.inf, -np.inf], np.nan)

    def z(s):
        s = s.dropna()
        return (s - s.median()) / (1.4826 * (s - s.median()).abs().mean() + 1e-9)

    trend = (100 * latest["slope_1y"]).clip(-1.5, 1.5)
    latest["trend_s"] = ((trend + 1.5) / 3.0 * 55 + 45 * latest["above_sma200"]).rank(pct=True) * 100

    m63 = latest["ret_63d"].fillna(0).clip(-0.5, 1.5)
    latest["mom_s"] = (100 * m63).rank(pct=True) * 100

    if {"return_on_equity", "operating_margins", "piotroski_f_score",
        "debt_to_equity", "revenue_growth"}.issubset(latest.columns):
        q = (z(latest["return_on_equity"].clip(0, 60)) +
             z(latest["operating_margins"].fillna(0)) +
             z(latest["piotroski_f_score"].fillna(0)) +
             z(-latest["debt_to_equity"].clip(0, 5)) +
             z(latest["revenue_growth"].clip(-1, 3)))
        latest["qual_s"] = (100 * q / 5).clip(0, 100)
    else:
        latest["qual_s"] = 50.0
    if "pledge_pct" in latest.columns:
        latest["qual_s"] = latest["qual_s"] - np.clip(latest["pledge_pct"].fillna(0), 0, 50) * 0.6

    if "pe_pct" in latest.columns:
        latest["val_s"] = (100 - latest["pe_pct"].clip(0, 1) * 100).clip(0, 100)
    else:
        latest["val_s"] = 50.0

    latest["final"] = (0.30 * latest["trend_s"] + 0.15 * latest["mom_s"] +
                       0.30 * latest["qual_s"] + 0.25 * latest["val_s"]).round(1).fillna(0.0)
    latest["bq_rank"] = latest["final"].rank(ascending=False, method="min").astype(int)
    return latest