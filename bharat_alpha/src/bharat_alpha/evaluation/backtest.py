"""Cost-aware, turnover-aware portfolio backtest — the arbiter of whether an edge is real.

A positive rank IC is a claim about ordering; this answers "is the book worth holding after
costs". Legacy found factors with well-powered, leak-checked positive IC (low-vol, t=+10.7)
that lost 0.5-0.9%/period net here — right-skewed returns + turnover. Periods are DISJOINT
(rebalance every h sessions, hold to the next rebalance), so the period count is already an
independent sample and a plain t-statistic is valid.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from bharat_alpha.costs import DEFAULT_COSTS, CostModel
from bharat_alpha.marketdata import Panel


@dataclass
class BacktestResult:
    periods: pd.DataFrame = field(repr=False)
    n_periods: int = 0
    mean_net_excess: float = float("nan")
    t_net_excess: float = float("nan")
    mean_gross_excess: float = float("nan")
    avg_turnover: float = float("nan")
    cost_drag_annual: float = float("nan")
    cagr_net: float = float("nan")
    sharpe_net: float = float("nan")
    max_drawdown: float = float("nan")
    years_positive: str = ""
    median_capacity_inr: float = float("nan")

    def summary(self) -> dict:
        d = asdict(self)
        d.pop("periods")
        return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in d.items()}


def _period_returns(p: Panel, e: int, x: int) -> pd.Series:
    """Return from open of session e to open of session x; last traded close if x missing."""
    o, c = p.open.iloc, p.close
    entry = o[e]
    exit_ = o[x].copy()
    miss = exit_.isna() & entry.notna()
    if miss.any():
        exit_[miss] = c.iloc[e:x].loc[:, miss].ffill().iloc[-1]
    return exit_ / entry - 1


def run_backtest(scores: pd.DataFrame, p: Panel, universe: pd.DataFrame, horizon: int, top_k: int,
                 buffer_mult: float = 2.0, costs: CostModel = DEFAULT_COSTS, max_participation: float = 0.02,
                 winsor: float | None = 0.005, anchor: pd.Timestamp | None = None) -> BacktestResult:
    """`anchor` fixes the rebalance calendar (anchor, anchor+h, ...) so two strategies run over
    the same window rebalance on the same dates and can be compared period by period."""
    idx = p.close.index
    pos = {d: i for i, d in enumerate(idx)}
    decision = [d for d in scores.index if d in pos and scores.loc[d].notna().sum() >= top_k]
    if not decision:
        return BacktestResult(periods=pd.DataFrame())
    # disjoint rebalance schedule: every `horizon` sessions from the anchor (default: first decision date);
    # scheduled dates without enough scores are skipped (the book holds to the next one)
    sched, i0 = [], pos[anchor] if anchor is not None and anchor in pos else pos[decision[0]]
    avail = set(pos[d] for d in decision)
    i = i0
    while i + 1 + horizon < len(idx):
        if i in avail:
            sched.append(i)
        i += horizon
    held: pd.Index = pd.Index([])
    w_old = pd.Series(dtype=float)
    adt = p.turnover.rolling(20, min_periods=15).mean()
    rows = []
    for j, t in enumerate(sched):
        nxt = sched[j + 1] if j + 1 < len(sched) else t + horizon
        if nxt + 1 >= len(idx):
            break
        d = idx[t]
        elig = universe.loc[d] & scores.loc[d].notna()
        ranked = scores.loc[d][elig].rank(ascending=False, method="first")
        keep = [s for s in held if s in ranked.index and ranked[s] <= top_k * buffer_mult]
        fill = [s for s in ranked.sort_values().index if s not in keep][: max(top_k - len(keep), 0)]
        new = pd.Index(keep[:top_k] + fill)
        w_new = pd.Series(1.0 / len(new), index=new)
        allk = w_new.index.union(w_old.index)
        dw = w_new.reindex(allk, fill_value=0) - w_old.reindex(allk, fill_value=0)
        cost = dw.clip(lower=0).sum() * costs.buy() + (-dw.clip(upper=0)).sum() * costs.sell()
        r = _period_returns(p, t + 1, nxt + 1)
        univ_r = r[elig[elig].index].dropna()
        if winsor and len(univ_r) > 20:
            lo, hi = univ_r.quantile(winsor, interpolation="higher"), univ_r.quantile(1 - winsor, interpolation="lower")
            univ_r, r = univ_r.clip(lo, hi), r.clip(lo, hi)
        port_r = r.reindex(new)
        # a holding with no entry print (halted at the open) sits in cash for the period
        gross = float((w_new * port_r.fillna(0.0)).sum())
        bench = float(univ_r.mean())
        cap = float((adt.loc[d].reindex(new) * max_participation * len(new)).min())
        rows.append({"date": d, "gross": gross, "cost": cost, "net": gross - cost, "bench": bench,
                     "turnover": float(dw.abs().sum() / 2), "n": len(new), "capacity_inr": cap})
        held, w_old = new, w_new
    per = pd.DataFrame(rows).set_index("date")
    if per.empty:
        return BacktestResult(periods=per)
    per["net_excess"] = per["net"] - per["bench"]
    per["gross_excess"] = per["gross"] - per["bench"]
    n = len(per)
    ppy = 252 / horizon
    x = per["net_excess"]
    eq = (1 + per["net"]).cumprod()
    years = per.groupby(per.index.year)["net_excess"].mean()
    return BacktestResult(
        periods=per, n_periods=n, mean_net_excess=float(x.mean()),
        t_net_excess=float(x.mean() / (x.std(ddof=1) / np.sqrt(n))) if n > 2 and x.std() > 0 else float("nan"),
        mean_gross_excess=float(per["gross_excess"].mean()), avg_turnover=float(per["turnover"].iloc[1:].mean()) if n > 1 else float("nan"),
        cost_drag_annual=float(per["cost"].mean() * ppy),
        cagr_net=float(eq.iloc[-1] ** (ppy / n) - 1),
        sharpe_net=float(per["net"].mean() / per["net"].std() * np.sqrt(ppy)) if per["net"].std() > 0 else float("nan"),
        max_drawdown=float((eq / eq.cummax() - 1).min()),
        years_positive=f"{int((years > 0).sum())}/{len(years)}",
        median_capacity_inr=float(per["capacity_inr"].median()),
    )
