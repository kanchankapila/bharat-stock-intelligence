"""Model registry: champion selection and promotion bookkeeping."""
from __future__ import annotations

import psycopg
from psycopg.types.json import Jsonb

from bharat_alpha.db import jsonable, read_df
from bharat_alpha.modeling.gate import GateVerdict, evaluate_gate


def champion(conn: psycopg.Connection, horizon: int) -> dict | None:
    df = read_df(conn, "SELECT * FROM alpha.model WHERE horizon=%s AND status='champion'", (horizon,))
    return df.iloc[0].to_dict() if len(df) else None


def lineage_ids(conn: psycopg.Connection, model_id: str) -> list[str]:
    """All models sharing this one's configuration (a refresh on newer data is the same
    lineage), so learned state and the realised track record survive scheduled retrains."""
    df = read_df(conn, """SELECT m2.model_id FROM alpha.model m1 JOIN alpha.model m2
                          ON m2.horizon = m1.horizon AND m2.params->>'config_hash' = m1.params->>'config_hash'
                          WHERE m1.model_id = %s ORDER BY m2.trained_at""", (model_id,))
    return list(df.model_id) or [model_id]


def model_row(conn: psycopg.Connection, model_id: str) -> dict:
    df = read_df(conn, "SELECT * FROM alpha.model WHERE model_id=%s", (model_id,))
    if df.empty:
        raise KeyError(model_id)
    return df.iloc[0].to_dict()


def _evaluate_registry_gate(candidate: dict, incumbent: dict | None, loader=None) -> GateVerdict:
    """Evaluate promotion while failing over only from a proven-unloadable incumbent.

    A binary sklearn artifact from another runtime is not a serving alternative. Requiring a
    candidate to beat an artifact that the current process cannot load leaves production with
    no model forever. The replacement must still clear every absolute/cost/benchmark gate; the
    only skipped comparison is versus the unavailable incumbent, and the reason is persisted in
    the gate report. Normal loadable champions retain the paired-improvement requirement.
    """
    if loader is None:
        from bharat_alpha.modeling.train import load_bundle
        loader = load_bundle

    # A candidate that cannot be loaded by the serving runtime is never promotable.
    loader(candidate["artifact_path"])
    incumbent_report = incumbent["cv_report"] if incumbent else None
    unavailable_reason = None
    if incumbent is not None:
        try:
            loader(incumbent["artifact_path"])
        except RuntimeError as exc:
            unavailable_reason = str(exc)
            incumbent_report = None

    verdict = evaluate_gate(candidate["cv_report"], incumbent_report)
    if unavailable_reason is not None:
        verdict.checks["incumbent_runtime_failover"] = {
            "ok": True,
            "mode": "absolute-gates-only",
            "incumbent_model_id": incumbent["model_id"],
            "reason": unavailable_reason,
        }
    return verdict


def serving_model(conn: psycopg.Connection, horizon: int) -> tuple[dict | None, str]:
    """The model predictions are made with, and the edge status they are published under.
    With no champion the newest candidate still predicts (so a live track record accrues),
    but everything it publishes is marked 'unvalidated'."""
    ch = champion(conn, horizon)
    if ch:
        return ch, "validated"
    df = read_df(conn, "SELECT * FROM alpha.model WHERE horizon=%s AND status IN ('candidate','rejected') "
                       "ORDER BY trained_at DESC LIMIT 1", (horizon,))
    return (df.iloc[0].to_dict(), "unvalidated") if len(df) else (None, "unvalidated")


def decide(conn: psycopg.Connection, model_id: str) -> GateVerdict:
    cand = model_row(conn, model_id)
    if cand["status"] == "champion" and isinstance(cand.get("gate_report"), dict):
        # Retries are normal around a slow artifact load. Do not compare a champion to itself
        # and overwrite the original promotion evidence (observed live 2026-10-13 after a
        # timed-out client retried while the first decision completed in the background).
        stored = cand["gate_report"]
        return GateVerdict(bool(stored.get("passed")), dict(stored.get("checks") or {}))
    ch = champion(conn, int(cand["horizon"]))
    verdict = _evaluate_registry_gate(cand, ch)
    with conn.cursor() as cur:
        if verdict.passed:
            if ch:
                cur.execute("UPDATE alpha.model SET status='retired' WHERE model_id=%s", (ch["model_id"],))
            cur.execute("UPDATE alpha.model SET status='champion', promoted_at=now(), gate_report=%s WHERE model_id=%s",
                        (Jsonb(jsonable(verdict.as_dict())), model_id))
        else:
            cur.execute("UPDATE alpha.model SET status='rejected', gate_report=%s WHERE model_id=%s",
                        (Jsonb(jsonable(verdict.as_dict())), model_id))
    conn.commit()
    return verdict
