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
    ch = champion(conn, int(cand["horizon"]))
    verdict = evaluate_gate(cand["cv_report"], ch["cv_report"] if ch else None)
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
