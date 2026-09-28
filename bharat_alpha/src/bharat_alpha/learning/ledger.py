"""Prediction ledger: score one decision date and append it, immutably.

Everything needed to grade the prediction later is written at decision time (score, rank,
calibrated expectation, interval, per-member scores) together with the feature snapshot, so
the grade can never be computed against a re-derived, silently different prediction.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from bharat_alpha.config import get_settings
from bharat_alpha.db import jsonable, read_df, upsert
from bharat_alpha.features import build_features, panel_window
from bharat_alpha.learning.adapt import latest_calibrator
from bharat_alpha.marketdata import load_panel
from bharat_alpha.modeling.registry import lineage_ids
from bharat_alpha.modeling.train import ModelBundle, load_bundle

FEATURE_LOOKBACK_SESSIONS = 300     # covers the 252-session momentum window plus warm-up


def latest_state(conn: psycopg.Connection, model_id: str, as_of: dt.date) -> tuple[dict | None, float | None]:
    """Latest learned ensemble weights and conformal level for this model's LINEAGE as of a date."""
    ids = lineage_ids(conn, model_id)
    w = read_df(conn, "SELECT weights FROM alpha.ensemble_weight WHERE model_id = ANY(%s) AND as_of_date<=%s "
                      "ORDER BY as_of_date DESC LIMIT 1", (ids, as_of))
    a = read_df(conn, "SELECT alpha_t FROM alpha.conformal_state WHERE model_id = ANY(%s) AND as_of_date<=%s "
                      "ORDER BY as_of_date DESC LIMIT 1", (ids, as_of))
    return (w.weights[0] if len(w) else None), (float(a.alpha_t[0]) if len(a) else None)


def snapshot_path(model_id: str, as_of: dt.date) -> Path:
    return Path(get_settings().artifacts_dir) / "snapshots" / model_id / f"{as_of:%Y%m%d}.parquet"


def predict_and_record(conn: psycopg.Connection, model: dict, as_of: dt.date, bundle: ModelBundle | None = None) -> pd.DataFrame:
    s = get_settings()
    bundle = bundle or load_bundle(model["artifact_path"])
    start, end = panel_window(as_of, FEATURE_LOOKBACK_SESSIONS, conn)
    if end != as_of:
        raise ValueError(f"{as_of} is not an ingested trading day (latest <= it is {end})")
    p = load_panel(conn, start, end)
    ff = build_features(conn, p, dates=pd.DatetimeIndex([pd.Timestamp(as_of)]))
    X = ff.data.reindex(columns=bundle.feature_cols)
    if X.empty:
        raise ValueError(f"no eligible instruments on {as_of}")
    weights, alpha_t = latest_state(conn, model["model_id"], as_of)
    alpha_t = alpha_t if alpha_t is not None else 1 - s.conformal_target_coverage
    scored = bundle.score(X, weights)
    half = bundle.interval(alpha_t)
    cal = latest_calibrator(lineage_ids(conn, model["model_id"]), as_of)
    if cal is not None:
        # realised-outcome calibration supersedes the training-time OOF estimate
        scored["pred_excess"] = cal["excess"].predict(scored["rank_pct"].to_numpy())
        scored["prob_outperform"] = cal["prob"].predict(scored["rank_pct"].to_numpy())
        q = min(max(1 - alpha_t, 0.0), 1.0)
        half = float(np.quantile(cal["abs_residuals"], q, method="higher"))
    member_cols = [m.name for m in bundle.members]
    rows = []
    for (d, iid), r in scored.iterrows():
        rows.append({
            "model_id": model["model_id"], "as_of_date": as_of, "instrument_id": int(iid), "horizon": bundle.horizon,
            "score": r["score"], "rank_pct": r["rank_pct"], "pred_excess": r["pred_excess"],
            "prob_outperform": r["prob_outperform"], "interval_lo": r["pred_excess"] - half,
            "interval_hi": r["pred_excess"] + half,
            "member_scores": Jsonb(jsonable({m: float(r[m]) for m in member_cols})),
        })
    upsert(conn, "alpha.prediction", rows, key=("model_id", "as_of_date", "instrument_id"), update=())
    path = snapshot_path(model["model_id"], as_of)
    path.parent.mkdir(parents=True, exist_ok=True)
    ff.data.reset_index().to_parquet(path, index=False)
    conn.commit()
    return scored
