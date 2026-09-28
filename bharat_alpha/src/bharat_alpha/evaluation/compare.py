"""Head-to-head grading of two rankings on the SAME dates with the SAME harness.

This is the cutover arbiter. The legacy `unified_recommendations` and this system's ledger are
graded identically: next-session open entry, liquidity-floored universe, per-date rank IC with
overlap correction, a cost-aware backtest on one shared rebalance calendar, and a paired
per-period test. Without this, "the new system is better" would be an opinion.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import psycopg

from bharat_alpha.config import get_settings
from bharat_alpha.db import read_df
from bharat_alpha.evaluation.backtest import run_backtest
from bharat_alpha.evaluation.metrics import evaluate_scores, newey_west_t, per_date_ic
from bharat_alpha.features import universe_mask
from bharat_alpha.labels import forward_returns
from bharat_alpha.marketdata import load_panel
from bharat_alpha.reference import SymbolResolver


def to_wide(conn: psycopg.Connection, scores: pd.DataFrame, index: pd.DatetimeIndex) -> pd.DataFrame:
    """scores: columns (date, symbol, score); `date` is an IST timestamp (or a date = its close).
    A score is a decision at the last close it could have been traded after: computed before
    the 09:15 IST open of session d -> decision d-1 (entered at d's open); computed later ->
    decision d (entered at d+1's open). Mapping everything to its calendar day would delay a
    pre-market ranker by one session and grade it unfairly."""
    res = SymbolResolver(conn)
    df = scores.copy()
    df["date"] = pd.to_datetime(df["date"])
    shifted = (df["date"] - pd.Timedelta(hours=9, minutes=15)).dt.normalize()
    has_time = df["date"] != df["date"].dt.normalize()
    anchor = shifted.where(has_time, df["date"])
    pos = index.searchsorted(anchor, side="right") - 1
    df = df[pos >= 0].copy()
    df["decision"] = index[pos[pos >= 0]]
    df["iid"] = [res.lookup(str(s).upper(), d.date()) for s, d in zip(df["symbol"], df["decision"])]
    df = df.dropna(subset=["iid", "score"])
    df["iid"] = df["iid"].astype(int)
    # several snapshots for one decision date: the last one written wins
    df = df.sort_values("date").drop_duplicates(["decision", "iid"], keep="last")
    return df.pivot(index="decision", columns="iid", values="score")


def ledger_scores(conn: psycopg.Connection, horizon: int, start: dt.date, end: dt.date) -> pd.DataFrame:
    """This system's published ranking: the ledger rows of whichever model served each date."""
    df = read_df(conn, """SELECT r.as_of_date AS date, s.symbol, r.score FROM alpha.recommendation r
                          JOIN alpha.symbol_history s ON s.instrument_id=r.instrument_id
                           AND s.valid_from <= r.as_of_date AND (s.valid_to IS NULL OR s.valid_to >= r.as_of_date)
                          WHERE r.horizon=%s AND r.as_of_date BETWEEN %s AND %s""", (horizon, start, end))
    return df


def compare(conn: psycopg.Connection, a: pd.DataFrame, b: pd.DataFrame, horizon: int,
            names: tuple[str, str] = ("legacy", "bharat_alpha")) -> dict:
    s = get_settings()
    lo = min(pd.to_datetime(a["date"]).min(), pd.to_datetime(b["date"]).min()).date()
    hi = max(pd.to_datetime(a["date"]).max(), pd.to_datetime(b["date"]).max()).date()
    days = read_df(conn, "SELECT trade_date FROM alpha.trading_day WHERE trade_date >= %s ORDER BY 1", (lo,))
    tail = days[days.trade_date > hi].trade_date.head(horizon + 2)
    end = tail.max() if len(tail) else hi
    # 300 sessions of warm-up so the liquidity floor and history filter are defined on day one
    warm = read_df(conn, "SELECT trade_date FROM alpha.trading_day WHERE trade_date <= %s ORDER BY 1 DESC LIMIT 300",
                   (lo,)).trade_date.min()
    p = load_panel(conn, warm, end)
    uni = universe_mask(p)
    lab = forward_returns(p, horizon, s.winsor_pct)
    wa, wb = to_wide(conn, a, p.dates), to_wide(conn, b, p.dates)
    common = wa.index.intersection(wb.index)
    common = common[lab.fwd.loc[common].notna().any(axis=1)]
    if len(common) == 0:
        return {"error": "no common decision dates with realised labels"}
    fwd = lab.fwd_w.where(uni)
    out: dict = {"horizon": horizon, "common_dates": len(common),
                 "span": [str(common.min().date()), str(common.max().date())]}
    ics, periods = {}, {}
    for name, w in zip(names, (wa, wb)):
        w = w.loc[common].where(uni.loc[common])
        rep = evaluate_scores(w, fwd.loc[common], horizon, s.top_k, s.min_effective_dates)
        bt = run_backtest(w, p, uni, horizon, s.top_k, s.hold_buffer_mult, anchor=common.min())
        rep["backtest"] = bt.summary()
        out[name] = rep
        ics[name] = per_date_ic(w, fwd.loc[common])
        periods[name] = bt.periods["net_excess"] if not bt.periods.empty else pd.Series(dtype=float)
    d_ic = (ics[names[1]] - ics[names[0]]).dropna()
    d_bt = (periods[names[1]] - periods[names[0]]).dropna()
    out["paired"] = {
        "ic_diff_mean": float(d_ic.mean()) if len(d_ic) else None,
        "ic_diff_t_nw": newey_west_t(d_ic, max(horizon - 1, 0)) if len(d_ic) > 2 else None,
        "net_excess_diff_mean": float(d_bt.mean()) if len(d_bt) else None,
        "net_excess_diff_t": float(d_bt.mean() / (d_bt.std(ddof=1) / np.sqrt(len(d_bt))))
        if len(d_bt) > 2 and d_bt.std() > 0 else None,
        "n_periods": int(len(d_bt)),
        "eff_dates": round(len(d_ic) / horizon, 2),
    }
    reliable = out["paired"]["eff_dates"] >= s.min_effective_dates
    t = out["paired"]["net_excess_diff_t"]
    out["verdict"] = ("LOW-DATA: not enough independent dates to choose" if not reliable else
                      f"{names[1]} better" if (t or 0) >= 2 else f"{names[0]} better" if (t or 0) <= -2 else
                      "no significant difference")
    return out


def load_legacy_ranker(legacy_dsn: str, start: dt.date, end: dt.date, timeframe: str | None = None) -> pd.DataFrame:
    """Legacy `unified_recommendations` (computed_at is TEXT there)."""
    q = """SELECT symbol, computed_at, unified_score AS score FROM public.unified_recommendations
           WHERE computed_at::date BETWEEN %s AND %s AND (%s::text IS NULL OR timeframe = %s)"""
    with psycopg.connect(legacy_dsn) as lc:
        df = read_df(lc, q, (start, end, timeframe, timeframe))
    ts = pd.to_datetime(df["computed_at"], utc=True, format="mixed").dt.tz_convert("Asia/Kolkata")
    df["date"] = ts.dt.tz_localize(None)
    return df[["date", "symbol", "score"]]
