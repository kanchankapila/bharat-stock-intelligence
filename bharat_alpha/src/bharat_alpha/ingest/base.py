"""Connector contract + run ledger.

A connector is three pure-ish steps — fetch (network), parse (pure; the ONLY parser, tests
call it directly), write (DB, through the connector's own writer) — plus a declaration of
what "healthy" means for it. Monitoring is generated from those declarations, so a source
cannot be registered without a freshness check and per-field fill-rate check (legacy: ~25 of
~140 fetchers were monitored; one target table was empty for its whole life unnoticed).
"""
from __future__ import annotations

import datetime as dt
import traceback
from dataclasses import dataclass, field
from typing import Any, ClassVar

import psycopg

from bharat_alpha.ingest.http import HttpClient


class NotPublished(Exception):
    """The upstream has no data for this date (holiday, not yet released, retired archive)."""


@dataclass(frozen=True)
class Health:
    table: str
    date_column: str
    warn_after_sessions: int = 1
    fail_after_sessions: int = 3
    # column -> minimum fraction non-null over the latest date's rows
    fill_rates: dict[str, float] = field(default_factory=dict)
    # optional extra WHERE clause to scope the table to this source's rows
    scope_sql: str = ""
    sparse: bool = False                # event-driven: stale only warns, never fails


class Connector:
    name: ClassVar[str]
    description: ClassVar[str]
    health: ClassVar[Health]
    per_date: ClassVar[bool] = True      # False = snapshot endpoint (no historical date param)
    # True when write() deliberately skips values identical to the latest stored one, so
    # "parsed rows, wrote none" means "nothing changed" rather than "write failed".
    dedupes_unchanged: ClassVar[bool] = False

    def fetch(self, client: HttpClient, on: dt.date) -> Any:
        raise NotImplementedError

    def parse(self, raw: Any, on: dt.date) -> list[dict]:
        raise NotImplementedError

    def write(self, conn: psycopg.Connection, rows: list[dict], on: dt.date) -> int:
        raise NotImplementedError


def run_connector(
    conn: psycopg.Connection,
    connector: Connector,
    on: dt.date,
    client: HttpClient | None = None,
    raw: Any = None,
) -> tuple[str, int]:
    """Fetch → parse → write inside one transaction, recording the outcome in alpha.ingest_run.

    `raw` lets a caller (tests, the legacy bridge) inject an already-fetched payload.
    Status is 'empty' when the parse produced rows but none were written, or when nothing
    parsed from a payload that was published — both are defects, never 'success'.
    """
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO alpha.ingest_run(source, target_date, status) VALUES (%s,%s,'running') RETURNING run_id",
            (connector.name, on),
        )
        run_id = cur.fetchone()[0]
    conn.commit()

    status, n, detail = "failed", 0, None
    try:
        if raw is None:
            raw = connector.fetch(client or HttpClient(), on)
        rows = connector.parse(raw, on)
        n = connector.write(conn, rows, on) if rows else 0
        if n > 0:
            status = "success"
        elif rows and connector.dedupes_unchanged:
            status, detail = "success", f"{len(rows)} rows parsed, none changed"
        else:
            status = "empty"
            detail = "payload parsed to zero rows" if not rows else f"{len(rows)} rows parsed, 0 written"
        conn.commit()
    except NotPublished as e:
        conn.rollback()
        status, detail = "not_published", str(e) or None
    except Exception:
        conn.rollback()
        status, detail = "failed", traceback.format_exc(limit=5)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE alpha.ingest_run SET status=%s, rows_written=%s, detail=%s, finished_at=now() WHERE run_id=%s",
            (status, n, detail, run_id),
        )
    conn.commit()
    return status, n
