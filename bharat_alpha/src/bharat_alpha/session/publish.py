"""Publish next-session picks (append-only) and grade them after that session closes."""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import psycopg

from bharat_alpha.config import get_settings
from bharat_alpha.costs import INTRADAY_COSTS
from bharat_alpha.db import get_status, read_df, set_status, upsert
from bharat_alpha.features import panel_window
from bharat_alpha.marketdata import load_panel
from bharat_alpha.modeling.registry import serving_model
from bharat_alpha.modeling.train import load_bundle
from bharat_alpha.session import (
    MAX_PARTICIPATION, capitulation, day_flags, day_level, next_session_oc, session_universe,
)
from bharat_alpha.session.model import SESSION_HORIZON, SESSION_TOP_K, session_frame
from bharat_alpha.timeutil import next_probable_session

RULE = "capitulation_rule"
LOOKBACK_SESSIONS = 300
RULE_STATUS_KEY = "session_rule"


def measure_rule(conn: psycopg.Connection, end: dt.date, sessions: int = 1500) -> dict:
    """Re-measure the capitulation rule on this system's own data (trailing window) and record
    whether it is currently validated here: t >= 2 over >= 20 signal-days, net of costs."""
    s = get_settings()
    start, end = panel_window(end, sessions, conn)
    p = load_panel(conn, start, end)
    uni = session_universe(p)
    res = day_level(capitulation(day_flags(p, uni)), next_session_oc(p), uni, p)
    summ = res.summary()
    summ["validated"] = bool(res.n_days >= s.min_effective_dates and res.t >= s.promotion_min_t and res.mean_net_spread > 0)
    summ["window"] = [str(start), str(end)]
    set_status(conn, RULE_STATUS_KEY, summ)
    conn.commit()
    return summ


def publish_session(conn: psycopg.Connection, as_of: dt.date) -> dict:
    """Picks for the next session, decided at `as_of`'s close."""
    trade_date = next_probable_session(as_of)
    start, end = panel_window(as_of, LOOKBACK_SESSIONS, conn)
    if end != as_of:
        raise ValueError(f"{as_of} is not an ingested trading day")
    p = load_panel(conn, start, end)
    d = pd.Timestamp(as_of)
    uni = session_universe(p)
    flags = day_flags(p, uni)
    adt = p.turnover.rolling(20, min_periods=15).mean().loc[d]
    out = {"trade_date": str(trade_date)}

    rule_status = get_status(conn, RULE_STATUS_KEY) or {}
    cap = capitulation(flags).loc[d]
    names = cap[cap].index
    ret = (p.close / p.close.ffill().shift(1) - 1).loc[d]
    rows = [{"strategy": RULE, "as_of_date": as_of, "trade_date": trade_date, "instrument_id": int(i),
             "score": float(-ret[i]), "rank": int(r + 1), "capacity_inr": float(adt[i] * MAX_PARTICIPATION),
             "edge_status": "validated" if rule_status.get("validated") else "unvalidated"}
            for r, i in enumerate(ret[names].sort_values().index)]
    out[RULE] = upsert(conn, "alpha.session_pick", rows, key=("strategy", "trade_date", "instrument_id"), update=())

    model, edge = serving_model(conn, SESSION_HORIZON)
    if model is not None:
        bundle = load_bundle(model["artifact_path"])
        X, _, _ = session_frame(conn, p, pd.DatetimeIndex([d]))
        scored = bundle.score(X.reindex(columns=bundle.feature_cols)).reset_index()
        top = scored.nlargest(SESSION_TOP_K, "score")
        mrows = [{"strategy": model["model_id"], "as_of_date": as_of, "trade_date": trade_date,
                  "instrument_id": int(r.instrument_id), "score": float(r.score), "rank": k + 1,
                  "capacity_inr": float(adt.get(int(r.instrument_id), np.nan) * MAX_PARTICIPATION), "edge_status": edge}
                 for k, r in enumerate(top.itertuples())]
        out[model["model_id"]] = upsert(conn, "alpha.session_pick", mrows,
                                        key=("strategy", "trade_date", "instrument_id"), update=())
    conn.commit()
    return out


def resolve_session(conn: psycopg.Connection, upto: dt.date) -> int:
    """Grade every pick whose session has closed: open->close of trade_date, minus round-trip
    intraday cost, minus that session's equal-weight universe (as defined at the decision)."""
    pending = read_df(conn, """SELECT DISTINCT sp.as_of_date, sp.trade_date FROM alpha.session_pick sp
                               LEFT JOIN alpha.session_outcome so USING (strategy, trade_date, instrument_id)
                               WHERE so.strategy IS NULL AND sp.trade_date <= %s""", (upto,))
    written = 0
    cost = INTRADAY_COSTS.round_trip()
    for r in pending.itertuples():
        traded = read_df(conn, "SELECT 1 FROM alpha.trading_day WHERE trade_date=%s", (r.trade_date,))
        if traded.empty:
            continue                                          # holiday or not ingested yet
        start, _ = panel_window(r.as_of_date, 30, conn)
        p = load_panel(conn, start, r.trade_date)
        uni = session_universe(p).loc[pd.Timestamp(r.as_of_date)]
        oc = (p.close / p.open - 1).loc[pd.Timestamp(r.trade_date)]
        universe_oc = float(oc[uni[uni].index].mean())
        picks = read_df(conn, "SELECT strategy, instrument_id FROM alpha.session_pick WHERE trade_date=%s AND as_of_date=%s",
                        (r.trade_date, r.as_of_date))
        rows = []
        for pk in picks.itertuples():
            v = oc.get(pk.instrument_id, np.nan)
            ok = v == v
            rows.append({"strategy": pk.strategy, "trade_date": r.trade_date, "instrument_id": int(pk.instrument_id),
                         "oc_return": float(v) if ok else None, "universe_oc": universe_oc,
                         "net_excess": float(v - cost - universe_oc) if ok else None})
        written += upsert(conn, "alpha.session_outcome", rows, key=("strategy", "trade_date", "instrument_id"), update=())
    conn.commit()
    return written


def session_track_record(conn: psycopg.Connection, strategy: str) -> dict:
    df = read_df(conn, """SELECT trade_date, avg(net_excess) AS day FROM alpha.session_outcome
                          WHERE strategy=%s AND net_excess IS NOT NULL GROUP BY 1 ORDER BY 1""", (strategy,))
    if df.empty:
        return {"n_days": 0}
    x = df["day"].astype(float)
    t = float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))) if len(x) > 2 and x.std() > 0 else None
    return {"n_days": int(len(x)), "mean_net_excess": float(x.mean()), "t": t, "pct_days_positive": float((x > 0).mean())}
