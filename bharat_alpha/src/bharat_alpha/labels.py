"""Forward-return labels, graded the way the book would actually be traded.

* Entry at the NEXT session's open after the decision date; exit at the open h sessions later.
  (A signal computed off a close cannot be bought at that close; legacy measured close-entry
  ICs overstating open-entry by >2x at h=1.)
* An instrument that stops trading inside the window exits at its last traded close
  ('stopped_trading') — dropping it would re-introduce survivorship.
* Winsorisation is per date with inward ('higher' low / 'lower' high) quantile interpolation. Linear
  interpolation clips a lone outlier only ~1% of the way toward the quantile and leaves the
  mean blown up (legacy ml-model-bugs.md).
* Excess is reported against BOTH the per-date equal-weight MEAN and the MEDIAN. Indian
  cross-sections are right-skewed; a factor can beat the median name and lose to the mean.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from bharat_alpha.marketdata import Panel


@dataclass
class Labels:
    horizon: int
    fwd: pd.DataFrame           # raw forward return (entry open t+1 -> exit open t+1+h)
    fwd_w: pd.DataFrame         # winsorised per date
    stopped: pd.DataFrame       # bool: exited early because the instrument stopped trading
    entry_date: pd.Series       # per decision date
    exit_date: pd.Series        # per decision date (NaT when the window is not yet complete)

    def excess(self, universe: pd.DataFrame, centre: str = "mean") -> pd.DataFrame:
        f = self.fwd_w.where(universe)
        c = f.mean(axis=1) if centre == "mean" else f.median(axis=1)
        return f.sub(c, axis=0)


def winsorize_rows(df: pd.DataFrame, pct: float) -> pd.DataFrame:
    arr = df.to_numpy(dtype=float, copy=True)
    out = np.full_like(arr, np.nan)
    for i in range(arr.shape[0]):
        row = arr[i]
        ok = ~np.isnan(row)
        if ok.sum() < 5:
            out[i, ok] = row[ok]
            continue
        # cutoffs must be OBSERVED values moved inward: 'higher' for the low tail, 'lower' for
        # the high tail. The opposite (or linear) leaves a lone outlier essentially unclipped.
        lo = np.quantile(row[ok], pct, method="higher")
        hi = np.quantile(row[ok], 1 - pct, method="lower")
        out[i, ok] = np.clip(row[ok], lo, hi)
    return pd.DataFrame(out, index=df.index, columns=df.columns)


def forward_returns(p: Panel, horizon: int, winsor_pct: float = 0.01) -> Labels:
    idx = p.close.index
    n = len(idx)
    o = p.open.to_numpy()
    c = p.close.to_numpy()
    fwd = np.full(o.shape, np.nan)
    stopped = np.zeros(o.shape, dtype=bool)
    entry_dates = pd.Series(pd.NaT, index=idx)
    exit_dates = pd.Series(pd.NaT, index=idx)
    for t in range(n):
        e, x = t + 1, t + 1 + horizon
        if x >= n:
            continue                              # window incomplete -> label unknown
        entry_dates.iloc[t], exit_dates.iloc[t] = idx[e], idx[x]
        entry = o[e]
        exit_ = o[x].copy()
        missing = np.isnan(exit_) & ~np.isnan(entry)
        if missing.any():
            # last traded close strictly inside the holding window
            window = c[e:x][:, missing]
            last = pd.DataFrame(window).ffill().iloc[-1].to_numpy() if window.size else np.full(missing.sum(), np.nan)
            exit_[missing] = last
            stopped[t, missing] = ~np.isnan(last)
        fwd[t] = exit_ / entry - 1
    fwd_df = pd.DataFrame(fwd, index=idx, columns=p.close.columns)
    return Labels(horizon, fwd_df, winsorize_rows(fwd_df, winsor_pct),
                  pd.DataFrame(stopped, index=idx, columns=p.close.columns), entry_dates, exit_dates)


def rank_gauss_target(fwd_w: pd.DataFrame, universe: pd.DataFrame) -> pd.DataFrame:
    from bharat_alpha.features import cs_rank_gauss

    return cs_rank_gauss(fwd_w, universe & fwd_w.notna())
