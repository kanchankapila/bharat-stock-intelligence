"""Read-only pooled DB access. All quant reads go through here."""
import logging
import contextlib
import psycopg2
import psycopg2.pool
import pandas as pd

from .config import POSTGRES_URL

log = logging.getLogger("bq.db")
_pool: psycopg2.pool.SimpleConnectionPool | None = None


def init_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.SimpleConnectionPool(1, 6, POSTGRES_URL, connect_timeout=10)
    return _pool


@contextlib.contextmanager
def get_conn():
    init_pool()
    conn = _pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute("SET default_transaction_read_only = on;")
        yield conn
    except Exception:
        raise
    finally:
        _pool.putconn(conn)


def qdf(sql: str, params: tuple | None = None) -> pd.DataFrame:
    with get_conn() as conn:
        return pd.read_sql(sql, conn, params=params or None)


def scalar(sql: str, params: tuple | None = None):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            row = cur.fetchone()
            return row[0] if row else None
