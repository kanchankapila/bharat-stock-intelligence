"""Migration runner.

Each .sql file is executed WHOLE inside one transaction and recorded with its checksum.
(Legacy: node-pg-migrate's sql runner silently executed only a file's first statement and
still wrote the ledger row — "written ≠ applied".) After applying, `verify()` asserts the
expected tables exist, reading information_schema qualified by schema name.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"

EXPECTED_TABLES = {
    "instrument", "symbol_history", "provider_id", "trading_day", "daily_bar", "adjustment",
    "fo_daily", "index_daily", "market_flow", "corporate_event", "deal", "fundamental",
    "ingest_run", "job_run", "dq_result", "system_status", "model", "prediction", "outcome",
    "realized_eval", "ensemble_weight", "conformal_state", "recommendation",
    "preopen_snapshot", "session_pick", "session_outcome",
}


def _ensure_ledger(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("CREATE SCHEMA IF NOT EXISTS alpha")
        cur.execute(
            "CREATE TABLE IF NOT EXISTS alpha.schema_migration ("
            " version TEXT PRIMARY KEY, checksum TEXT NOT NULL,"
            " applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
    conn.commit()


def applied(conn: psycopg.Connection) -> dict[str, str]:
    _ensure_ledger(conn)
    with conn.cursor() as cur:
        cur.execute("SELECT version, checksum FROM alpha.schema_migration")
        return dict(cur.fetchall())


def migrate(conn: psycopg.Connection, directory: Path = MIGRATIONS_DIR) -> list[str]:
    done = applied(conn)
    ran: list[str] = []
    for path in sorted(directory.glob("*.sql")):
        text = path.read_text()
        digest = hashlib.sha256(text.encode()).hexdigest()
        version = path.stem
        if version in done:
            if done[version] != digest:
                raise RuntimeError(f"migration {version} was edited after being applied")
            continue
        with conn.cursor() as cur:
            cur.execute(text)
            cur.execute(
                "INSERT INTO alpha.schema_migration(version, checksum) VALUES (%s, %s)",
                (version, digest),
            )
        conn.commit()
        ran.append(version)
    verify(conn)
    return ran


def verify(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'alpha'"
        )
        present = {r[0] for r in cur.fetchall()}
    missing = EXPECTED_TABLES - present
    if missing:
        raise RuntimeError(f"schema verification failed; missing tables: {sorted(missing)}")
