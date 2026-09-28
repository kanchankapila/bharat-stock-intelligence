"""Live monitoring of the serving model against reality, and the retrain decision.

* Realised edge: rank IC of the ledger vs realised returns, overlap-corrected. A champion
  whose realised IC is significantly negative on a reliable panel is marked 'degraded' and
  its output is published as such — the system says so instead of hiding it.
* Feature coverage drift: per-feature non-null share today vs at training. (Stock features are
  rank-Gaussian per date, so their marginal distribution cannot drift by construction —
  what CAN rot is coverage: legacy's ROE fill fell 86% -> 6% with a "fresh" table.)
* Error analysis: a shallow tree fitted on the prediction-time feature snapshot to the
  realised rank error, surfacing the segments the model is systematically wrong on.
* Retrain trigger: schedule, degraded edge, coverage drift, or enough new labels.
"""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd
import psycopg
from sklearn.tree import DecisionTreeRegressor

from bharat_alpha.config import get_settings
from bharat_alpha.db import read_df, set_status
from bharat_alpha.evaluation.metrics import summarize_ic
from bharat_alpha.learning.ledger import snapshot_path
from bharat_alpha.modeling.registry import lineage_ids

RETRAIN_EVERY_SESSIONS = 21
COVERAGE_DROP_ALERT = 0.25          # absolute drop in a feature's non-null share


def realized_edge(conn: psycopg.Connection, model_id: str, horizon: int) -> dict:
    s = get_settings()
    ev = read_df(conn, "SELECT DISTINCT ON (as_of_date) as_of_date, rank_ic, topk_excess, interval_cover "
                       "FROM alpha.realized_eval WHERE model_id = ANY(%s) AND member='ensemble' "
                       "ORDER BY as_of_date, model_id", (lineage_ids(conn, model_id),))
    if ev.empty:
        return {"n_dates": 0, "status": "no_outcomes_yet"}
    summ = summarize_ic(ev.set_index("as_of_date")["rank_ic"], horizon, s.min_effective_dates).as_dict()
    summ["topk_excess_mean"] = float(ev.topk_excess.mean())
    summ["interval_coverage"] = float(ev.interval_cover.mean())
    if summ["eff_dates"] >= s.min_effective_dates / 2 and (summ["t_nw"] or 0) <= -2.0:
        summ["status"] = "degraded"
    elif summ["reliable"] and summ["mean_ic"] > 0 and (summ["t_nw"] or 0) >= 2.0:
        summ["status"] = "confirmed"
    else:
        summ["status"] = "accumulating"
    return summ


def coverage_drift(conn: psycopg.Connection, model: dict, as_of: dt.date) -> dict:
    path = snapshot_path(model["model_id"], as_of)
    if not path.exists():
        return {}
    snap = pd.read_parquet(path)
    report = model["cv_report"]
    base = report.get("feature_coverage") or {}
    now = {c: float(snap[c].notna().mean()) for c in snap.columns if c not in ("date", "instrument_id")}
    drops = {c: {"train": base[c], "now": now.get(c, 0.0)} for c in base if base[c] - now.get(c, 0.0) >= COVERAGE_DROP_ALERT}
    return {"coverage_now": now, "coverage_drops": drops}


def error_segments(conn: psycopg.Connection, model_id: str, max_dates: int = 60, min_leaf_frac: float = 0.05) -> list[dict]:
    """Where is the model systematically wrong? Fit depth-3 tree: snapshot features -> (realised
    rank pct - predicted rank pct), report leaves with a material mean error."""
    df = read_df(conn, """
        SELECT p.as_of_date, p.instrument_id, p.rank_pct, o.fwd_return FROM alpha.prediction p
        JOIN alpha.outcome o USING (model_id, as_of_date, instrument_id)
        WHERE p.model_id=%s ORDER BY p.as_of_date DESC""", (model_id,))
    if df.empty:
        return []
    dates = sorted(df.as_of_date.unique())[-max_dates:]
    frames = []
    for d in dates:
        path = snapshot_path(model_id, d)
        if not path.exists():
            continue
        snap = pd.read_parquet(path)
        snap["as_of_date"] = d
        frames.append(snap.drop(columns=["date"]))
    if not frames:
        return []
    snap = pd.concat(frames)
    df = df[df.as_of_date.isin(dates)].copy()
    df["real_pct"] = df.groupby("as_of_date")["fwd_return"].rank(pct=True)
    df["err"] = df["real_pct"] - df["rank_pct"]
    m = df.merge(snap, on=["as_of_date", "instrument_id"], how="inner")
    feats = [c for c in snap.columns if c not in ("as_of_date", "instrument_id")]
    if len(m) < 200 or not feats:
        return []
    X = m[feats].fillna(0.0)
    tree = DecisionTreeRegressor(max_depth=3, min_samples_leaf=max(int(len(m) * min_leaf_frac), 50), random_state=0)
    tree.fit(X, m["err"])
    leaves = tree.apply(X)
    out = []
    for leaf in np.unique(leaves):
        mask = leaves == leaf
        mean_err = float(m.loc[mask, "err"].mean())
        se = float(m.loc[mask, "err"].std() / np.sqrt(mask.sum()))
        path_desc = _leaf_path(tree, feats, leaf)
        out.append({"rule": path_desc, "n": int(mask.sum()), "mean_rank_error": round(mean_err, 4),
                    "t": round(mean_err / se, 2) if se > 0 else None,
                    "reading": "model ranks these too LOW" if mean_err > 0 else "model ranks these too HIGH"})
    return sorted(out, key=lambda r: -abs(r["mean_rank_error"]))


def _leaf_path(tree, feats, leaf) -> str:
    t = tree.tree_
    parent = {}
    for node in range(t.node_count):
        for child, side in ((t.children_left[node], "<="), (t.children_right[node], ">")):
            if child != -1:
                parent[child] = (node, side)
    parts, node = [], leaf
    while node in parent:
        p, side = parent[node]
        parts.append(f"{feats[t.feature[p]]} {side} {t.threshold[p]:.2f}")
        node = p
    return " AND ".join(reversed(parts)) or "(all)"


def needs_retrain(conn: psycopg.Connection, model: dict | None, as_of: dt.date, edge: dict, drift: dict) -> tuple[bool, str]:
    if model is None:
        return True, "no model"
    days = read_df(conn, "SELECT count(*) AS n FROM alpha.trading_day WHERE trade_date > %s AND trade_date <= %s",
                   (model["train_end"], as_of))
    since = int(days.n[0])
    if edge.get("status") == "degraded":
        return True, "realised edge degraded"
    if drift.get("coverage_drops"):
        return True, f"feature coverage dropped: {sorted(drift['coverage_drops'])}"
    if since >= RETRAIN_EVERY_SESSIONS + int(model["horizon"]):
        return True, f"{since} sessions of new labels since training"
    return False, "up to date"


def publish_monitor_status(conn: psycopg.Connection, horizon: int, payload: dict) -> None:
    set_status(conn, f"monitor_h{horizon}", payload)
    conn.commit()
