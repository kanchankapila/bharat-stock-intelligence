"""Reverse-engineer the movers -- graded against BOTH tails.

"What did the big gainers have in common beforehand?" selects on the dependent
variable, so it always returns something, and what it returns is almost always a
volatility detector: a feature that says a stock will MOVE, not which way.

Measured on this platform twice, by two unrelated routes:
  * legacy, 40 screener concept-tags vs top-20 gainers: 8 of 40 cleared a
    Bonferroni bar on winners; 0 of 40 survived once the losing tail was graded.
  * bharat_alpha, 35 point-in-time features, h=5, 271 non-overlapping dates:
    31 of 35 would clear on winners-only, 14 of 35 clear on separation.
    `vol_63` scores t=+43.5 winners-only and separates the tails by -0.03.

The asymmetry runs both ways, which is the part that is easy to miss: the single
best directional feature in that run (`close_loc_21`, separation t=-8.90) reads
t=-0.60 winners-only, so the naive study DISCARDS the real signal while chasing
the detectors. That is why this module never reports one tail without the other.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats


def mover_separation(ds, k: int = 20, min_dates: int = 20) -> pd.DataFrame:
    """Per-date percentile rank of each feature among the top-k and bottom-k forward movers.

    `separation` = mean_rank(winners) - mean_rank(losers). A volatility detector puts both
    tails on the same side of 0.5 and separates them by ~0; a directional feature does not.

    Dates are decimated to every `horizon`-th so the windows do not overlap -- overlapping
    windows treated as independent is what reduced 24 USABLE factor verdicts to 1 here.
    Statistics are computed per date and then aggregated, never pooled.
    """
    dates = list(ds.dates)[:: ds.horizon]
    cols = list(ds.X.columns)
    win: dict[str, list[float]] = {c: [] for c in cols}
    los: dict[str, list[float]] = {c: [] for c in cols}

    for d in dates:
        try:
            x, e = ds.X.xs(d, level="date"), ds.excess.xs(d, level="date")
        except KeyError:
            continue
        e = e.dropna()
        if len(e) < 5 * k:          # need a cross-section wide enough for both tails to mean anything
            continue
        pct = x.reindex(e.index).rank(pct=True)
        top, bot = e.nlargest(k).index, e.nsmallest(k).index
        for c in cols:
            a, b = pct.loc[top, c].mean(), pct.loc[bot, c].mean()
            if np.isfinite(a) and np.isfinite(b):
                win[c].append(a)
                los[c].append(b)

    rows = []
    for c in cols:
        w, l = np.array(win[c]), np.array(los[c])
        if len(w) < min_dates:
            continue
        sep = w - l
        rows.append({
            "feature": c, "n_dates": len(w),
            "win_rank": w.mean(), "los_rank": l.mean(),
            "separation": sep.mean(),
            "t_separation": stats.ttest_1samp(sep, 0.0).statistic,
            # Reported to be argued with, not acted on: this is the winners-only statistic,
            # i.e. the number the trap produces. Kept beside the honest one on purpose.
            "t_winners_only": stats.ttest_1samp(w, 0.5).statistic,
        })

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    bonf = stats.norm.ppf(1 - 0.05 / (2 * len(df)))
    df["bonferroni_t"] = bonf
    df["directional"] = df.t_separation.abs() > bonf
    df["winners_only_would_clear"] = df.t_winners_only.abs() > bonf
    return df.sort_values("t_separation", key=abs, ascending=False).reset_index(drop=True)
