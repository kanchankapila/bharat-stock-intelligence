"""The single measurement harness. Every number the system reports comes from here.

Rules baked in (each one corrected a false conclusion in the legacy repo):
  * Per date, then average. Never pooled.
  * Overlapping windows are not independent: effective dates = dates / horizon, and
    t-statistics use Newey-West with (horizon - 1) lags. A reading with fewer than
    `min_effective_dates` is labelled LOW-DATA and cannot pass any gate.
  * Report top-k excess against the equal-weight MEAN (what a book is benchmarked to) as
    well as rank IC (a claim about ORDERING only); flag the "median-beater" case.
  * AUC is reported against BOTH tails and tail-vs-tail. Winners-only AUC cannot tell
    "predicts winners" from "predicts volatility".
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd


def _rank_rows(a: np.ndarray) -> np.ndarray:
    return pd.DataFrame(a).rank(axis=1).to_numpy()


def per_date_ic(scores: pd.DataFrame, fwd: pd.DataFrame, min_names: int = 10) -> pd.Series:
    s, f = scores.align(fwd, join="inner")
    ok = s.notna() & f.notna()
    s, f = s.where(ok), f.where(ok)
    rs, rf = s.rank(axis=1), f.rank(axis=1)
    ic = rs.corrwith(rf, axis=1)
    return ic[ok.sum(axis=1) >= min_names].dropna()


def newey_west_t(x: pd.Series | np.ndarray, lags: int) -> float:
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    n = len(x)
    if n < 3:
        return float("nan")
    e = x - x.mean()
    var = e @ e / n
    for l in range(1, min(lags, n - 1) + 1):
        w = 1 - l / (lags + 1)
        var += 2 * w * (e[l:] @ e[:-l]) / n
    if var <= 0:
        return float("nan")
    return float(x.mean() / np.sqrt(var / n))


@dataclass
class ICSummary:
    horizon: int
    n_dates: int
    eff_dates: float
    mean_ic: float
    ic_std: float
    t_nw: float
    pct_positive: float
    reliable: bool

    def as_dict(self) -> dict:
        return asdict(self)


def summarize_ic(ic: pd.Series, horizon: int, min_effective_dates: float = 20.0) -> ICSummary:
    n = int(ic.notna().sum())
    eff = n / max(horizon, 1)
    return ICSummary(
        horizon=horizon, n_dates=n, eff_dates=round(eff, 2),
        mean_ic=float(ic.mean()) if n else float("nan"), ic_std=float(ic.std()) if n > 1 else float("nan"),
        t_nw=newey_west_t(ic, max(horizon - 1, 0)), pct_positive=float((ic > 0).mean()) if n else float("nan"),
        reliable=eff >= min_effective_dates,
    )


def topk_excess(scores: pd.DataFrame, fwd: pd.DataFrame, k: int) -> pd.DataFrame:
    """Per date: mean fwd of the top-k by score minus the universe mean and minus the median."""
    s, f = scores.align(fwd, join="inner")
    rows = []
    for d in s.index:
        sv, fv = s.loc[d], f.loc[d]
        ok = sv.notna() & fv.notna()
        if ok.sum() < max(2 * k, 10):
            continue
        top = sv[ok].nlargest(k).index
        rows.append({"date": d, "top": fv[top].mean(), "mean": fv[ok].mean(), "median": fv[ok].median()})
    df = pd.DataFrame(rows).set_index("date") if rows else pd.DataFrame(columns=["top", "mean", "median"])
    df["exc_mean"] = df["top"] - df["mean"]
    df["exc_median"] = df["top"] - df["median"]
    return df


def _auc(pos: np.ndarray, neg: np.ndarray) -> float:
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    allv = np.concatenate([pos, neg])
    ranks = pd.Series(allv).rank().to_numpy()
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def tail_aucs(scores: pd.DataFrame, fwd: pd.DataFrame, q: float = 0.2) -> dict[str, float]:
    s, f = scores.align(fwd, join="inner")
    win, lose, sep = [], [], []
    for d in s.index:
        sv, fv = s.loc[d], f.loc[d]
        ok = sv.notna() & fv.notna()
        if ok.sum() < 20:
            continue
        sv, fv = sv[ok].to_numpy(), fv[ok].to_numpy()
        hi, lo = np.quantile(fv, 1 - q), np.quantile(fv, q)
        top, bot, mid = fv >= hi, fv <= lo, (fv > lo) & (fv < hi)
        win.append(_auc(sv[top], sv[~top]))
        lose.append(_auc(-sv[bot], -sv[~bot]))
        sep.append(_auc(sv[top], sv[bot]))
    return {"auc_winners": float(np.nanmean(win)) if win else np.nan,
            "auc_losers": float(np.nanmean(lose)) if lose else np.nan,
            "auc_win_vs_lose": float(np.nanmean(sep)) if sep else np.nan}


def decile_returns(scores: pd.DataFrame, fwd: pd.DataFrame, n_bins: int = 10) -> pd.Series:
    s, f = scores.align(fwd, join="inner")
    out = []
    for d in s.index:
        sv, fv = s.loc[d], f.loc[d]
        ok = sv.notna() & fv.notna()
        if ok.sum() < n_bins * 3:
            continue
        b = pd.qcut(sv[ok].rank(method="first"), n_bins, labels=False)
        out.append(fv[ok].groupby(b).mean() - fv[ok].mean())
    return pd.concat(out, axis=1).mean(axis=1) if out else pd.Series(dtype=float)


def evaluate_scores(scores: pd.DataFrame, fwd: pd.DataFrame, horizon: int, k: int,
                    min_effective_dates: float = 20.0) -> dict:
    ic = per_date_ic(scores, fwd)
    summ = summarize_ic(ic, horizon, min_effective_dates)
    tk = topk_excess(scores, fwd, k)
    exc = tk["exc_mean"].dropna()
    out = summ.as_dict()
    out.update(tail_aucs(scores, fwd))
    out["topk_exc_mean"] = float(exc.mean()) if len(exc) else float("nan")
    out["topk_exc_median"] = float(tk["exc_median"].mean()) if len(tk) else float("nan")
    out["topk_t_nw"] = newey_west_t(exc, max(horizon - 1, 0))
    out["median_beater"] = bool(out["mean_ic"] > 0 and out["topk_exc_mean"] < 0)
    dec = decile_returns(scores, fwd)
    out["decile_excess"] = [round(float(x), 5) for x in dec.to_numpy()]
    return out
