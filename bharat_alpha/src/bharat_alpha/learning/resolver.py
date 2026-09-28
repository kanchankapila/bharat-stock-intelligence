"""Grade ledger predictions against what actually happened.

Accuracy here is ALWAYS realised forward return versus the prediction written at decision
time — never a job's success flag or a model's self-reported CV (legacy's "accuracy from
a proxy" class). Entry/exit conventions are identical to training labels (labels.py).
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import psycopg

from bharat_alpha.config import get_settings
from bharat_alpha.db import read_df, upsert
from bharat_alpha.labels import winsorize_rows
from bharat_alpha.marketdata import load_panel


def _trading_days(conn) -> pd.DatetimeIndex:
    d = read_df(conn, "SELECT trade_date FROM alpha.trading_day ORDER BY 1")
    return pd.DatetimeIndex(pd.to_datetime(d.trade_date))


def resolve_outcomes(conn: psycopg.Connection, upto: dt.date) -> int:
    s = get_settings()
    days = _trading_days(conn)
    pos = {d.date(): i for i, d in enumerate(days)}
    pending = read_df(conn, """
        SELECT DISTINCT p.model_id, p.as_of_date, p.horizon FROM alpha.prediction p
        LEFT JOIN alpha.outcome o USING (model_id, as_of_date, instrument_id)
        WHERE o.model_id IS NULL ORDER BY p.as_of_date""")
    written = 0
    for r in pending.itertuples():
        i = pos.get(r.as_of_date)
        if i is None:
            continue
        e, x = i + 1, i + 1 + int(r.horizon)
        if x >= len(days) or days[x].date() > upto:
            continue
        preds = read_df(conn, """SELECT instrument_id, score, pred_excess, interval_lo, interval_hi, member_scores
                                 FROM alpha.prediction WHERE model_id=%s AND as_of_date=%s""", (r.model_id, r.as_of_date))
        p = load_panel(conn, days[e].date(), days[x].date())
        entry = p.open.iloc[0].reindex(preds.instrument_id)     # NaN if it did not trade: ungradeable
        exit_ = p.open.iloc[-1].reindex(preds.instrument_id)
        last_close = p.close.reindex(columns=preds.instrument_id).iloc[:-1].ffill().iloc[-1] if len(p.close) > 1 \
            else pd.Series(np.nan, index=preds.instrument_id)
        stopped = exit_.isna() & entry.notna() & last_close.notna()
        exit_ = exit_.where(~stopped, last_close)
        fwd = (exit_ / entry - 1)
        fwd_w = winsorize_rows(fwd.to_frame().T, s.winsor_pct).iloc[0]
        ok = fwd_w.notna()
        if ok.sum() < 5:
            continue
        mean, median = float(fwd_w[ok].mean()), float(fwd_w[ok].median())
        rows = [{"model_id": r.model_id, "as_of_date": r.as_of_date, "instrument_id": int(iid), "horizon": int(r.horizon),
                 "entry_date": days[e].date(), "exit_date": days[x].date(), "fwd_return": float(fwd_w[iid]),
                 "universe_mean": mean, "universe_median": median, "excess_mean": float(fwd_w[iid]) - mean,
                 "exit_reason": "stopped_trading" if stopped[iid] else "horizon"}
                for iid in fwd_w[ok].index]
        written += upsert(conn, "alpha.outcome", rows, key=("model_id", "as_of_date", "instrument_id"), update=())
        _grade_date(conn, r.model_id, r.as_of_date, preds, fwd_w, mean, s.top_k)
    conn.commit()
    return written


def _grade_date(conn, model_id: str, as_of: dt.date, preds: pd.DataFrame, fwd_w: pd.Series, mean: float, k: int) -> None:
    pr = preds.set_index("instrument_id")
    f = fwd_w.dropna()
    pr = pr.loc[pr.index.intersection(f.index)]
    f = f.loc[pr.index]
    if len(f) < 10:
        return
    exc = f - mean
    members = pd.DataFrame(list(pr["member_scores"]), index=pr.index)
    rows = []

    def ic(x: pd.Series) -> float:
        return float(x.rank().corr(f.rank()))

    top = pr["score"].nlargest(min(k, len(pr))).index
    cover = float(((exc >= pr["interval_lo"]) & (exc <= pr["interval_hi"])).mean())
    rows.append({"model_id": model_id, "as_of_date": as_of, "member": "ensemble", "n": int(len(f)),
                 "rank_ic": ic(pr["score"]), "topk_excess": float(exc[top].mean()), "interval_cover": cover})
    for m in members.columns:
        mtop = members[m].nlargest(min(k, len(pr))).index
        rows.append({"model_id": model_id, "as_of_date": as_of, "member": m, "n": int(len(f)),
                     "rank_ic": ic(members[m]), "topk_excess": float(exc[mtop].mean()), "interval_cover": None})
    upsert(conn, "alpha.realized_eval", rows, key=("model_id", "as_of_date", "member"))
