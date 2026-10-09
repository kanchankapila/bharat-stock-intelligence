"""Shadow arms rebuilt at grading time from unified_recommendations_history (spec 2026-10-08, section 2.C.1).

Pure functions on a DataFrame with one row per (session, symbol) and the history columns regime, unified_score,
classification, ml_score, confluence_score, technical_score, breakout_score. No database access here.

Arms:
  published       the stored unified_score (every overlay and veto the ranker applied)
  reblend         per-session percentile normalisation (unified_ranker._normalize_to_100) of the four weighted engines,
                  blended with the live REGIME_WEIGHTS, weights renormalised over the engines present for that symbol
  reblend_vol_veto  reblend x0.7 on the top 20% of the session by 20-day realised vol (vol passed in)
  reblend_no_ml   reblend without the ml engine
  random_control  the published scores shuffled within each session (same distribution, no information), seeded
ponytail: the ranker's zero-dispersion engine drop, quality gate and red-flag vetoes are not replayed; `published` carries them.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from unified_ranker import REGIME_WEIGHTS

ENGINES = ("ml", "confluence", "technical", "breakout")
ARMS = ("published", "reblend", "reblend_vol_veto", "reblend_no_ml", "random_control")
VOL_VETO_TOP_SHARE = 0.20
VOL_VETO_MULT = 0.7


def _pct100(s: pd.Series) -> pd.Series:
    # (less + 0.5 * equal) / n * 100 == (average rank - 0.5) / n * 100, n = present values in the session
    return (s.rank(method="average") - 0.5) / s.notna().sum() * 100.0


def reblend(df: pd.DataFrame, drop=()) -> pd.Series:
    num = pd.Series(0.0, index=df.index)
    den = pd.Series(0.0, index=df.index)
    regime = df["regime"].astype(str).str.upper()
    for e in ENGINES:
        if e in drop:
            continue
        v = df.groupby("session")[f"{e}_score"].transform(_pct100)
        w = regime.map(lambda r: REGIME_WEIGHTS.get(r, REGIME_WEIGHTS["BULL"])[e])   # ranker falls back to BULL
        ok = v.notna() & (w > 0)
        num += np.where(ok, w * v.fillna(0.0), 0.0)
        den += np.where(ok, w, 0.0)
    return (num / den.where(den > 0)).rename("reblend")


def reblend_no_ml(df: pd.DataFrame) -> pd.Series:
    return reblend(df, drop=("ml",)).rename("reblend_no_ml")


def reblend_vol_veto(df: pd.DataFrame, vol: pd.Series) -> pd.Series:
    base = reblend(df)
    rank = vol.groupby(df["session"]).rank(pct=True)
    return base.where(~(rank > 1 - VOL_VETO_TOP_SHARE), base * VOL_VETO_MULT).rename("reblend_vol_veto")


def published(df: pd.DataFrame) -> pd.Series:
    return df["unified_score"]


def random_control(df: pd.DataFrame, seed: int = 0) -> pd.Series:
    rng = np.random.default_rng(seed)
    out = pd.Series(np.nan, index=df.index, name="random_control")
    for _, idx in df.groupby("session").groups.items():
        out.loc[idx] = rng.permutation(df.loc[idx, "unified_score"].to_numpy(copy=True))
    return out


def arm_scores(df: pd.DataFrame, vol: pd.Series, seed: int = 0) -> pd.DataFrame:
    return pd.DataFrame({"published": published(df), "reblend": reblend(df), "reblend_vol_veto": reblend_vol_veto(df, vol),
                         "reblend_no_ml": reblend_no_ml(df), "random_control": random_control(df, seed)}, index=df.index)


def session_ic(df: pd.DataFrame, score: pd.Series, fwd: pd.Series, date_col: str = "session", min_n: int = 30) -> pd.Series:
    """Spearman rank IC of score vs forward return, one value per session (thin or degenerate sessions dropped)."""
    d = pd.DataFrame({"d": df[date_col], "s": score, "f": fwd}).dropna()
    out = {}
    for k, g in d.groupby("d"):
        if len(g) >= min_n and g["s"].nunique() > 3:
            out[k] = g["s"].rank().corr(g["f"].rank())
    return pd.Series(out, dtype=float)
