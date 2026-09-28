"""Postgres access. One dialect, explicit connections, no hidden pools.

Functions that take a `conn` use that connection — they never open their own (legacy bug:
a function that ignored its `conn` argument defeated every caller's transaction/isolation).
"""
from __future__ import annotations

import contextlib
import math
from typing import Iterable, Iterator, Sequence

import numpy as np
import pandas as pd
import psycopg
from psycopg import sql

from bharat_alpha.config import get_settings


def connect(dsn: str | None = None) -> psycopg.Connection:
    dsn = dsn or get_settings().database_url
    conn = psycopg.connect(dsn, autocommit=False)
    return conn


@contextlib.contextmanager
def transaction(dsn: str | None = None) -> Iterator[psycopg.Connection]:
    conn = connect(dsn)
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def read_df(conn: psycopg.Connection, query: str, params: Sequence | dict | None = None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(query, params)
        if cur.description is None:
            return pd.DataFrame()
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def to_db(v):
    """DB boundary coercion. NaN/inf become NULL (pandas turns None into NaN in mixed float
    columns, so an upstream `is None` guard cannot be relied on); numpy scalars become Python."""
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, pd.Timestamp):
        return v.to_pydatetime()
    return v


def jsonable(x):
    """Make a value safe for JSONB: NaN/inf -> null (Postgres rejects them), numpy -> Python,
    dates -> ISO strings."""
    import datetime as _dt

    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set)):
        return [jsonable(v) for v in x]
    if isinstance(x, (np.floating, float)):
        return float(x) if math.isfinite(float(x)) else None
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    if isinstance(x, (_dt.date, _dt.datetime, pd.Timestamp)):
        return x.isoformat()
    return x


def upsert(
    conn: psycopg.Connection,
    table: str,
    rows: Iterable[dict],
    key: Sequence[str],
    update: Sequence[str] | None = None,
    page_size: int = 5000,
) -> int:
    """Batched INSERT … ON CONFLICT. `update=None` updates every non-key column; `update=()`
    means DO NOTHING (append-only tables). Returns rows actually inserted or updated (a DO
    NOTHING conflict is not counted), so "sent 500, wrote 0" is visible to the caller.

    Callers pass `update` explicitly for tables with a generation timestamp so it is never
    overwritten on conflict.
    """
    rows = list(rows)
    if not rows:
        return 0
    cols = list(rows[0].keys())
    schema, name = table.split(".")
    if update is None:
        update = [c for c in cols if c not in key]
    conflict = sql.SQL(", ").join(map(sql.Identifier, key))
    if update:
        action = sql.SQL("DO UPDATE SET ") + sql.SQL(", ").join(
            sql.SQL("{c} = EXCLUDED.{c}").format(c=sql.Identifier(c)) for c in update
        )
    else:
        action = sql.SQL("DO NOTHING")
    stmt = sql.SQL("INSERT INTO {t} ({cols}) VALUES ({ph}) ON CONFLICT ({conflict}) {action}").format(
        t=sql.Identifier(schema, name),
        cols=sql.SQL(", ").join(map(sql.Identifier, cols)),
        ph=sql.SQL(", ").join(sql.Placeholder() * len(cols)),
        conflict=conflict,
        action=action,
    )
    written = 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), page_size):
            chunk = rows[i : i + page_size]
            cur.executemany(stmt, [tuple(to_db(r[c]) for c in cols) for r in chunk])
            written += max(cur.rowcount, 0)
    return written


def set_status(conn: psycopg.Connection, key: str, value: dict) -> None:
    from psycopg.types.json import Jsonb

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO alpha.system_status(key, value, updated_at) VALUES (%s, %s, now()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            (key, Jsonb(jsonable(value))),
        )


def get_status(conn: psycopg.Connection, key: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT value FROM alpha.system_status WHERE key = %s", (key,))
        r = cur.fetchone()
    return r[0] if r else None
