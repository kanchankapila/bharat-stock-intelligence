"""Build and record portfolio targets; backtest the optimiser against equal-weight top-k."""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from bharat_alpha.config import get_settings
from bharat_alpha.costs import DEFAULT_COSTS, CostModel
from bharat_alpha.db import jsonable, read_df, upsert
from bharat_alpha.evaluation.backtest import _period_returns
from bharat_alpha.features import panel_window
from bharat_alpha.marketdata import Panel, load_panel
from bharat_alpha.portfolio import PortfolioConfig, estimate_risk, optimise

RISK_LOOKBACK = 126


def _inputs(p: Panel, d: pd.Timestamp, names: pd.Index, capital: float, cfg: PortfolioConfig):
    ret = (p.close / p.close.shift(1) - 1)
    pos = p.dates.get_loc(d)
    window = ret.iloc[max(pos - RISK_LOOKBACK + 1, 0): pos + 1]
    market = window.mean(axis=1)
    risk = estimate_risk(window.reindex(columns=names), market)
    adt = p.turnover.rolling(20, min_periods=15).mean().loc[d].reindex(names)
    liq_cap = (adt * cfg.max_participation / capital).fillna(0.0)
    return risk, liq_cap


def build_targets(conn: psycopg.Connection, as_of: dt.date, horizon: int, capital: float,
                  cfg: PortfolioConfig = PortfolioConfig()) -> dict:
    s = get_settings()
    rec = read_df(conn, """SELECT instrument_id, rank, pred_excess, edge_status FROM alpha.recommendation
                           WHERE as_of_date=%s AND horizon=%s ORDER BY rank""", (as_of, horizon))
    if rec.empty:
        raise ValueError(f"no recommendations for {as_of} h={horizon}")
    prev = read_df(conn, """SELECT t.instrument_id, t.weight FROM alpha.portfolio_target t
                            JOIN alpha.portfolio_run r USING (run_id)
                            WHERE r.horizon=%s AND r.as_of_date = (SELECT max(as_of_date) FROM alpha.portfolio_run
                                                                   WHERE horizon=%s AND as_of_date < %s)""",
                     (horizon, horizon, as_of))
    prev_w = pd.Series(prev.weight.to_numpy(), index=prev.instrument_id.astype(int)) if len(prev) else None
    top = rec[rec["rank"] <= s.top_k * cfg.candidates_mult]
    names = pd.Index(sorted(set(top.instrument_id.astype(int)) | set(prev_w.index if prev_w is not None else [])))
    mu = rec.set_index("instrument_id")["pred_excess"].reindex(names)
    mu = mu.fillna(mu.min() if mu.notna().any() else 0.0)      # a held name that fell out: worst known view
    start, end = panel_window(as_of, RISK_LOOKBACK + 30, conn)
    p = load_panel(conn, start, end)
    d = pd.Timestamp(as_of)
    risk, liq = _inputs(p, d, names, capital, cfg)
    sector = read_df(conn, "SELECT instrument_id, sector FROM alpha.instrument WHERE instrument_id = ANY(%s)",
                     ([int(x) for x in names],)).set_index("instrument_id")["sector"]
    res = optimise(mu, risk, horizon, sector, liq, prev_w, cfg)
    price = p.raw_close.loc[d].reindex(res.weights.index)
    edge = str(rec.edge_status.iloc[0])
    beta = float((res.weights * risk.beta.reindex(res.weights.index)).sum() / max(res.weights.sum(), 1e-12))
    est_cost = float(res.turnover * 2 * capital * (DEFAULT_COSTS.buy() + DEFAULT_COSTS.sell()) / 2)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM alpha.portfolio_run WHERE as_of_date=%s AND horizon=%s", (as_of, horizon))
        cur.execute("""INSERT INTO alpha.portfolio_run(as_of_date, horizon, capital_inr, edge_status, n_positions,
                           gross_exposure, ex_ante_vol, ex_ante_beta, turnover, est_cost_inr, binding)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING run_id""",
                    (as_of, horizon, capital, edge, int(len(res.weights)), float(res.weights.sum()), res.ex_ante_vol,
                     beta, res.turnover, est_cost, Jsonb(jsonable(res.binding))))
        run_id = cur.fetchone()[0]
    rows = [{"run_id": run_id, "instrument_id": int(i), "weight": float(w), "value_inr": float(w * capital),
             "shares": float(np.floor(w * capital / price[i])) if price.get(i, np.nan) == price.get(i, np.nan) else 0.0,
             "cap_reason": res.cap_reason.get(i)} for i, w in res.weights.items()]
    upsert(conn, "alpha.portfolio_target", rows, key=("run_id", "instrument_id"))
    conn.commit()
    return {"run_id": run_id, "n_positions": len(rows), "gross": float(res.weights.sum()), "ex_ante_vol": res.ex_ante_vol,
            "beta": beta, "turnover": res.turnover, "edge_status": edge, "binding": res.binding}


def compare_construction(scores: pd.DataFrame, mu: pd.DataFrame, p: Panel, universe: pd.DataFrame, horizon: int,
                         top_k: int, capital: float, cfg: PortfolioConfig = PortfolioConfig(),
                         sector: pd.Series | None = None, costs: CostModel = DEFAULT_COSTS) -> dict:
    """Disjoint-period backtest of equal-weight top-k vs the optimiser on the same scores and
    the same rebalance dates. `mu` = expected excess per name per date (same shape as scores)."""
    idx = p.dates
    sched = [i for i in range(0, len(idx) - horizon - 1, horizon) if idx[i] in scores.index
             and scores.loc[idx[i]].notna().sum() >= top_k and i >= RISK_LOOKBACK]
    sector = sector if sector is not None else pd.Series(dtype=object)
    books = {"equal_weight": pd.Series(dtype=float), "optimised": pd.Series(dtype=float)}
    rows = []
    for j, i in enumerate(sched):
        d = idx[i]
        nxt = sched[j + 1] if j + 1 < len(sched) else i + horizon
        if nxt + 1 >= len(idx):
            break
        elig = universe.loc[d] & scores.loc[d].notna()
        ranked = scores.loc[d][elig].sort_values(ascending=False)
        r = _period_returns(p, i + 1, nxt + 1)
        bench = float(r[elig[elig].index].dropna().mean())
        ew = pd.Series(1.0 / top_k, index=ranked.index[:top_k])
        cand = pd.Index(ranked.index[: top_k * cfg.candidates_mult]).union(books["optimised"].index)
        risk, liq = _inputs(p, d, cand, capital, cfg)
        opt = optimise(mu.loc[d].reindex(cand).fillna(mu.loc[d].min()), risk, horizon, sector, liq,
                       books["optimised"], cfg, costs).weights
        rec = {"date": d, "bench": bench}
        for name, w in (("equal_weight", ew), ("optimised", opt)):
            prev = books[name]
            allk = w.index.union(prev.index)
            dw = w.reindex(allk, fill_value=0) - prev.reindex(allk, fill_value=0)
            cost = dw.clip(lower=0).sum() * costs.buy() + (-dw.clip(upper=0)).sum() * costs.sell()
            gross_ret = float((w * r.reindex(w.index).fillna(0.0)).sum())       # uninvested weight = cash (0%)
            rec[f"{name}_net"] = gross_ret - cost
            rec[f"{name}_turnover"] = float(dw.abs().sum() / 2)
            rec[f"{name}_gross"] = float(w.sum())
            books[name] = w
        rows.append(rec)
    df = pd.DataFrame(rows).set_index("date")
    ppy = 252 / horizon
    out = {"n_periods": len(df)}
    for name in books:
        net = df[f"{name}_net"]
        exc = net - df["bench"] * df[f"{name}_gross"]          # excess vs the same exposure to the universe
        out[name] = {"mean_net": float(net.mean()), "vol_annual": float(net.std() * np.sqrt(ppy)),
                     "sharpe": float(net.mean() / net.std() * np.sqrt(ppy)) if net.std() > 0 else float("nan"),
                     "mean_excess": float(exc.mean()),
                     "t_excess": float(exc.mean() / (exc.std(ddof=1) / np.sqrt(len(exc)))) if len(exc) > 2 else float("nan"),
                     "avg_turnover": float(df[f"{name}_turnover"].iloc[1:].mean()), "avg_gross": float(df[f"{name}_gross"].mean())}
    return out
