"""Portfolio construction: from a ranking to sized, constrained, cost-aware positions.

    maximise   mu'w  -  lambda * w' Sigma_h w  -  sum_i c_i |w_i - w_prev_i|
    subject to 0 <= w_i <= min(max_weight, liquidity_cap_i)
               sum_{i in sector s} w_i <= sector_cap        (unknown sector = its own bucket)
               sum w <= max_gross
    then scale the book to the volatility target (the remainder is cash).

* mu      = calibrated expected excess over the horizon (the ledger's pred_excess), so the
            optimiser trades off the model's own honest estimate, not a raw score.
* Sigma_h = Ledoit-Wolf shrunk daily covariance x horizon (126 sessions; sample covariance
            of ~100 names on 126 days is singular-ish and overfits).
* c_i     = the real per-side transaction cost, so a name is traded only when its expected
            gain beats what the trade costs — turnover control from the cost model itself,
            not a hand-tuned penalty.
* Every limit is a Settings field; nothing here re-tunes silently when a universe shrinks
  (legacy: a hard-coded coverage constant cut 90% of positions by 10%).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from sklearn.covariance import LedoitWolf

from bharat_alpha.costs import DEFAULT_COSTS, CostModel

UNKNOWN_SECTOR = "__unknown__"


@dataclass(frozen=True)
class PortfolioConfig:
    max_weight: float = 0.05
    sector_cap: float = 0.25
    max_gross: float = 1.0
    target_vol_annual: float = 0.18
    risk_aversion: float = 5.0
    max_participation: float = 0.02      # of ADT, per rebalance
    min_weight: float = 0.002            # smaller positions are rounded to zero (not worth a trade)
    candidates_mult: int = 3             # optimise over the top (mult x top_k) plus current holdings


@dataclass
class RiskModel:
    names: pd.Index
    cov_daily: pd.DataFrame
    beta: pd.Series

    def vol_annual(self, w: pd.Series) -> float:
        w = w.reindex(self.names).fillna(0.0).to_numpy()
        return float(np.sqrt(max(w @ self.cov_daily.to_numpy() @ w, 0.0) * 252))


def estimate_risk(returns: pd.DataFrame, market: pd.Series, min_obs: int = 60) -> RiskModel:
    """returns: daily simple returns (dates x names). Names with < min_obs observations get
    the cross-sectional median variance and zero covariance (known-unknown, not dropped)."""
    ok = returns.notna().sum() >= min_obs
    good = returns.loc[:, ok]
    filled = good.sub(good.mean()).fillna(0.0)
    lw = LedoitWolf().fit(filled.to_numpy())
    cov = pd.DataFrame(lw.covariance_, index=good.columns, columns=good.columns)
    names = returns.columns
    full = pd.DataFrame(0.0, index=names, columns=names)
    full.loc[good.columns, good.columns] = cov
    med = float(np.median(np.diag(cov))) if len(cov) else 0.0004
    for n in names[~ok]:
        full.loc[n, n] = med
    m = market.reindex(returns.index)
    var_m = float(m.var()) or np.nan
    beta = returns.apply(lambda c: c.cov(m) / var_m if c.notna().sum() >= min_obs else np.nan)
    return RiskModel(names, full, beta.fillna(1.0))


@dataclass
class OptimResult:
    weights: pd.Series
    cap_reason: dict[str, str] = field(default_factory=dict)
    binding: dict = field(default_factory=dict)
    ex_ante_vol: float = float("nan")
    turnover: float = float("nan")


def optimise(mu: pd.Series, risk: RiskModel, horizon: int, sector: pd.Series, liquidity_cap: pd.Series,
             prev: pd.Series | None, cfg: PortfolioConfig, costs: CostModel = DEFAULT_COSTS) -> OptimResult:
    names = mu.index
    n = len(names)
    prev_w = (prev if prev is not None else pd.Series(dtype=float)).reindex(names).fillna(0.0).to_numpy()
    S = risk.cov_daily.reindex(index=names, columns=names).fillna(0.0).to_numpy() * horizon
    m = mu.fillna(0.0).to_numpy()
    ub = np.minimum(cfg.max_weight, liquidity_cap.reindex(names).fillna(0.0).clip(lower=0).to_numpy())
    cb, cs = costs.buy(), costs.sell()
    lam = cfg.risk_aversion

    # variables x = [w, buy, sell];  w = prev + buy - sell
    def f(x):
        w, b, s = x[:n], x[n:2 * n], x[2 * n:]
        return -(m @ w) + lam * (w @ S @ w) + cb * b.sum() + cs * s.sum()

    def g(x):
        w, b, s = x[:n], x[n:2 * n], x[2 * n:]
        return np.concatenate([-m + 2 * lam * (S @ w), np.full(n, cb), np.full(n, cs)])

    cons = [{"type": "eq", "fun": lambda x: x[:n] - prev_w - x[n:2 * n] + x[2 * n:],
             "jac": lambda x: np.hstack([np.eye(n), -np.eye(n), np.eye(n)])},
            {"type": "ineq", "fun": lambda x: cfg.max_gross - x[:n].sum(),
             "jac": lambda x: np.concatenate([-np.ones(n), np.zeros(2 * n)])}]
    sec = sector.reindex(names).fillna(UNKNOWN_SECTOR)
    for s_name, members in sec.groupby(sec).groups.items():
        mask = np.isin(names, list(members)).astype(float)
        cons.append({"type": "ineq", "fun": lambda x, mask=mask: cfg.sector_cap - mask @ x[:n],
                     "jac": lambda x, mask=mask: np.concatenate([-mask, np.zeros(2 * n)])})
    bounds = [(0.0, float(u)) for u in ub] + [(0.0, None)] * (2 * n)
    def start(w0):
        return np.concatenate([w0, np.clip(w0 - prev_w, 0, None), np.clip(prev_w - w0, 0, None)])

    # SLSQP warm-started AT the current book sometimes stops there and reports success (measured:
    # 4 of 30 float-noise jitters of one problem, objective short of the true optimum). The problem
    # is convex, so solve from the book and from cash and keep the lower objective.
    runs = [minimize(f, start(w0), jac=g, bounds=bounds, constraints=cons, method="SLSQP",
                     options={"maxiter": 500, "ftol": 1e-10})
            for w0 in (np.minimum(prev_w, ub), np.zeros(n))]
    feasible = [r for r in runs if r.success] or runs
    res = min(feasible, key=lambda r: r.fun)
    w = np.clip(res.x[:n], 0.0, None)
    w[w < cfg.min_weight] = 0.0
    weights = pd.Series(w, index=names)

    reasons: dict = {}
    for nm, wi, u, mc in zip(names, w, ub, liquidity_cap.reindex(names).fillna(0.0)):
        if wi > 0 and abs(wi - u) < 1e-6:
            reasons[nm] = "liquidity" if mc < cfg.max_weight else "max_weight"
    binding = {"optimizer_success": bool(res.success), "message": str(res.message),
               "sectors_at_cap": sorted(str(s) for s, g in weights.groupby(sec).sum().items()
                                        if g >= cfg.sector_cap - 1e-6)}
    vol = risk.vol_annual(weights)
    if vol > cfg.target_vol_annual > 0:
        weights = weights * (cfg.target_vol_annual / vol)
        binding["vol_target_scaled_by"] = round(cfg.target_vol_annual / vol, 4)
        vol = cfg.target_vol_annual
    binding["gross"] = float(weights.sum())
    turnover = float(np.abs(weights.to_numpy() - prev_w).sum() / 2)
    return OptimResult(weights[weights > 0], reasons, binding, vol, turnover)
