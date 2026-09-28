"""The daily DAG. Each step is its own ledgered, idempotent job keyed by (job, as_of_date), so a
step that dies does not silently take the steps after it down (legacy: tail-of-script steps
under a timeout never ran while the job reported success), and a re-run skips work already
done instead of duplicating it.

    ingest -> quality -> resolve+adapt -> monitor/retrain -> predict -> publish -> dq checks
"""
from __future__ import annotations

import datetime as dt
import traceback
from typing import Callable

import psycopg
from psycopg.types.json import Jsonb

from bharat_alpha.config import get_settings
from bharat_alpha.db import jsonable, read_df, upsert
from bharat_alpha.ingest.base import run_connector
from bharat_alpha.ingest.http import HttpClient
from bharat_alpha.ingest.registry import CONNECTORS, EOD_SEQUENCE
from bharat_alpha.learning.adapt import update_adaptive_state
from bharat_alpha.learning.ledger import predict_and_record
from bharat_alpha.learning.monitor import (
    coverage_drift, error_segments, needs_retrain, publish_monitor_status, realized_edge,
)
from bharat_alpha.learning.resolver import resolve_outcomes
from bharat_alpha.marketdata import derive_adjustments, flag_suspect_bars
from bharat_alpha.modeling.dataset import build_dataset
from bharat_alpha.modeling.registry import decide, serving_model
from bharat_alpha.modeling.train import train_model
from bharat_alpha.quality.checks import run_checks

TRAIN_HISTORY_DAYS = 365 * 6


def run_step(conn: psycopg.Connection, job: str, as_of: dt.date, fn: Callable[[], dict | None], force: bool = False) -> dict:
    if not force:
        done = read_df(conn, "SELECT 1 FROM alpha.job_run WHERE job=%s AND as_of_date=%s AND status='success' LIMIT 1",
                       (job, as_of))
        if len(done):
            return {"status": "skipped", "reason": "already succeeded"}
    with conn.cursor() as cur:
        cur.execute("INSERT INTO alpha.job_run(job, as_of_date, status) VALUES (%s,%s,'running') RETURNING run_id",
                    (job, as_of))
        run_id = cur.fetchone()[0]
    conn.commit()
    try:
        detail = fn() or {}
        status = "success"
    except Exception:
        conn.rollback()
        detail, status = {"error": traceback.format_exc(limit=8)}, "failed"
    with conn.cursor() as cur:
        cur.execute("UPDATE alpha.job_run SET status=%s, detail=%s, finished_at=now() WHERE run_id=%s",
                    (status, Jsonb(jsonable(detail)), run_id))
    conn.commit()
    return {"status": status, **detail}


def step_ingest(conn: psycopg.Connection, as_of: dt.date, client: HttpClient | None = None) -> dict:
    client = client or HttpClient()
    res = {}
    for name in EOD_SEQUENCE:
        status, n = run_connector(conn, CONNECTORS[name](), as_of, client=client)
        res[name] = {"status": status, "rows": n}
    if res["nse_bhavcopy"]["status"] not in ("success",):
        raise RuntimeError(f"bhavcopy not ingested for {as_of}: {res['nse_bhavcopy']}")
    return res


def step_quality(conn: psycopg.Connection, as_of: dt.date) -> dict:
    start = as_of - dt.timedelta(days=10)
    flagged = flag_suspect_bars(conn, start)
    adj = derive_adjustments(conn, start)
    conn.commit()
    return {"suspect_flags_changed": flagged, "adjustments_written": adj}


def step_learn(conn: psycopg.Connection, as_of: dt.date) -> dict:
    n = resolve_outcomes(conn, as_of)
    out = {"outcomes_written": n, "models": {}}
    models = read_df(conn, "SELECT DISTINCT p.model_id, m.horizon FROM alpha.prediction p JOIN alpha.model m USING (model_id)")
    for r in models.itertuples():
        out["models"][r.model_id] = update_adaptive_state(conn, r.model_id, int(r.horizon), as_of)
    return out


def step_monitor_and_retrain(conn: psycopg.Connection, as_of: dt.date, horizon: int) -> dict:
    model, _ = serving_model(conn, horizon)
    edge = realized_edge(conn, model["model_id"], horizon) if model else {}
    drift = coverage_drift(conn, model, as_of) if model else {}
    retrain, why = needs_retrain(conn, model, as_of, edge, drift)
    out = {"model_id": model["model_id"] if model else None, "realized": edge,
           "coverage_drops": drift.get("coverage_drops"), "retrain": retrain, "reason": why}
    if model:
        out["error_segments"] = error_segments(conn, model["model_id"])[:5]
    if retrain:
        start = as_of - dt.timedelta(days=TRAIN_HISTORY_DAYS)
        ds = build_dataset(conn, start, as_of, horizon)
        res = train_model(conn, ds)
        verdict = decide(conn, res.model_id)
        out["trained"] = {"model_id": res.model_id, "gate_passed": verdict.passed, "failures": verdict.failures}
    publish_monitor_status(conn, horizon, out)
    return out


def step_predict_and_publish(conn: psycopg.Connection, as_of: dt.date, horizon: int) -> dict:
    s = get_settings()
    model, edge_status = serving_model(conn, horizon)
    if model is None:
        raise RuntimeError(f"no model for horizon {horizon}")
    realized = realized_edge(conn, model["model_id"], horizon)
    if realized.get("status") == "degraded":
        edge_status = "degraded"
    scored = predict_and_record(conn, model, as_of)
    sc = scored.reset_index()
    sc["rank"] = sc["score"].rank(ascending=False, method="first").astype(int)
    n = len(sc)
    rows = []
    for r in sc.itertuples():
        action = "BUY" if r.rank <= s.top_k else ("AVOID" if r.rank > n - s.top_k else "HOLD")
        rows.append({"as_of_date": as_of, "horizon": horizon, "instrument_id": int(r.instrument_id),
                     "model_id": model["model_id"], "rank": int(r.rank), "action": action, "score": r.score,
                     "pred_excess": r.pred_excess, "prob_outperform": r.prob_outperform,
                     "interval_lo": None, "interval_hi": None, "edge_status": edge_status})
    pr = read_df(conn, "SELECT instrument_id, interval_lo, interval_hi FROM alpha.prediction WHERE model_id=%s AND as_of_date=%s",
                 (model["model_id"], as_of)).set_index("instrument_id")
    for row in rows:
        if row["instrument_id"] in pr.index:
            row["interval_lo"] = pr.at[row["instrument_id"], "interval_lo"]
            row["interval_hi"] = pr.at[row["instrument_id"], "interval_hi"]
    # the canonical table is a full recomputation for (date, horizon): purge rows this run did not produce
    with conn.cursor() as cur:
        cur.execute("DELETE FROM alpha.recommendation WHERE as_of_date=%s AND horizon=%s", (as_of, horizon))
    upsert(conn, "alpha.recommendation", rows, key=("as_of_date", "horizon", "instrument_id"))
    conn.commit()
    return {"model_id": model["model_id"], "edge_status": edge_status, "n": n}


def run_daily(conn: psycopg.Connection, as_of: dt.date, ingest: bool = True, client: HttpClient | None = None,
              force: bool = False) -> dict:
    s = get_settings()
    out = {}
    if ingest:
        out["ingest"] = run_step(conn, "ingest", as_of, lambda: step_ingest(conn, as_of, client), force)
        if out["ingest"]["status"] == "failed":
            return out
    out["quality"] = run_step(conn, "quality", as_of, lambda: step_quality(conn, as_of), force)
    out["learn"] = run_step(conn, "learn", as_of, lambda: step_learn(conn, as_of), force)
    for h in s.horizons:
        out[f"monitor_h{h}"] = run_step(conn, f"monitor_h{h}", as_of, lambda h=h: step_monitor_and_retrain(conn, as_of, h), force)
        out[f"publish_h{h}"] = run_step(conn, f"publish_h{h}", as_of, lambda h=h: step_predict_and_publish(conn, as_of, h), force)
    checks = run_checks(conn, as_of, s.horizons)
    out["dq"] = {"fail": [c.check_id for c in checks if c.status == "fail"],
                 "warn": [c.check_id for c in checks if c.status == "warn"]}
    return out


