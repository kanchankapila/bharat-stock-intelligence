"""
Dual-mode data-access layer for the Python engines (Phase 3 / P3f).

The Python analog of the TypeScript `dbAsync` facade. Exposes a small synchronous API
(connect / query_all / query_one / query_scalar / execute / executemany / transaction /
read_df / get_engine) that routes to either SQLite or PostgreSQL, selected by the
USE_POSTGRES env var. Engines converted to this API keep running on SQLite today; the
SQLite->Postgres cutover is then a single env flip — no further code change.

Everything executes through a SQLAlchemy `text()` connection so dialect/paramstyle
differences are handled by SQLAlchemy and the sql_translate translator. Rows are returned
as a `Row` (a dict subclass) that supports BOTH name access (row['col']) and positional
access (row[0]), matching the sqlite3.Row surface the engines already rely on.

Conversion notes for P3f:
  - Pass parameters as a positional tuple/list: query_all(sql, [a, b]).
  - For an inserted id on Postgres, add `RETURNING id` and read it (lastrowid is SQLite-only).
  - `conn.row_factory = sqlite3.Row` lines become unnecessary — remove them.
  - SQLite-only SQL (INSERT OR REPLACE, strftime, PRAGMA table_info) must be hand-converted.
"""
import os
from pathlib import Path
from urllib.parse import quote_plus

import pandas as pd
from sqlalchemy import create_engine, text

# Auto-load .env once per process (not on every importlib.reload).
# Uses override=False so tests that set DATABASE_URL/USE_POSTGRES before importing are unaffected.
import sys as _sys
if "db_compat:_dotenv_loaded" not in _sys.modules:
    _sys.modules["db_compat:_dotenv_loaded"] = object()  # sentinel survives reload
    try:
        from dotenv import load_dotenv as _load_dotenv
        _env_file = Path(__file__).resolve().parents[2] / ".env"
        if _env_file.exists():
            _load_dotenv(_env_file, override=False)
    except ImportError:
        pass

try:  # works whether run as a script (src/server on sys.path) or imported as a package
    from sql_translate import translate, build_params, use_postgres
except ImportError:  # pragma: no cover
    from .sql_translate import translate, build_params, use_postgres


# ─── Connection URL / engine ───────────────────────────────────────────────────

def _sqlite_url() -> str:
    env = os.environ.get("DATABASE_URL")
    if env and env.startswith("sqlite"):
        return env
    db_path = Path(__file__).resolve().parent.parent.parent / "database.sqlite"
    return f"sqlite:///{db_path}"


def _pg_url() -> str:
    url = os.environ.get("POSTGRES_URL")
    if url:
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
        elif url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg2://", 1)
        # On Windows, 'localhost' resolves to ::1 (IPv6) which Docker resets;
        # force IPv4 so psycopg2 connects to 127.0.0.1 instead.
        url = url.replace("@localhost:", "@127.0.0.1:")
        return url
    user = os.environ.get("POSTGRES_USER", "bharat")
    pw = os.environ.get("POSTGRES_PASSWORD", "bharat")
    host = os.environ.get("POSTGRES_HOST", "localhost")
    if host == "localhost":
        host = "127.0.0.1"
    port = os.environ.get("POSTGRES_PORT", "5433")
    db = os.environ.get("POSTGRES_DB", "bharat_intel")
    return f"postgresql+psycopg2://{user}:{quote_plus(pw)}@{host}:{port}/{db}"


def database_url() -> str:
    return _pg_url() if use_postgres() else _sqlite_url()


_engines: dict = {}


def get_engine():
    """Cached SQLAlchemy Engine for the active dialect (one per resolved URL/process)."""
    url = database_url()
    eng = _engines.get(url)
    if eng is None:
        eng = create_engine(url, pool_pre_ping=True, future=True)
        _engines[url] = eng
    return eng


# ─── Row: dual-access (name + positional) ──────────────────────────────────────

class Row(dict):
    """Mapping + sequence, mirroring sqlite3.Row. Supports name access (row['col']),
    positional access (row[0]), and iteration/tuple-unpacking over VALUES (the engines
    rely on `for a, b in rows` and `list(row)` yielding column values, not keys)."""

    def __init__(self, columns, values):
        super().__init__(zip(columns, values))
        self._values = tuple(values)

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)

    def __iter__(self):
        return iter(self._values)


def _rows(result):
    cols = list(result.keys())
    return [Row(cols, tuple(r)) for r in result.fetchall()]


def _one(result):
    cols = list(result.keys())
    r = result.fetchone()
    return Row(cols, tuple(r)) if r is not None else None


# ─── Cursor / connection wrappers (legacy sqlite3 surface) ─────────────────────

class _EmptyResult:
    """Stand-in for a SQLAlchemy CursorResult when executemany() is called with zero
    rows — sqlite3 treats that as a no-op, but passing an empty list to
    Connection.execute() makes SQLAlchemy compile a single no-params execution instead
    of "executemany with 0 iterations", raising a spurious missing-bind-parameter error."""
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def keys(self):
        return []


class CursorWrapper:
    """Mimics the subset of sqlite3.Cursor the engines use: execute/executemany +
    fetchone/fetchall + rowcount/lastrowid."""

    def __init__(self, conn):
        self._conn = conn
        self._result = None

    def execute(self, sql, params=()):
        self._result = self._conn.execute(text(translate(sql)), build_params(params))
        return self

    def executemany(self, sql, seq_of_params):
        if not seq_of_params:
            self._result = _EmptyResult()
            return self
        self._result = self._conn.execute(
            text(translate(sql)), [build_params(p) for p in seq_of_params]
        )
        return self

    def fetchone(self):
        return _one(self._result) if self._result is not None else None

    def fetchall(self):
        return _rows(self._result) if self._result is not None else []

    @property
    def rowcount(self):
        return self._result.rowcount if self._result is not None else -1

    @property
    def lastrowid(self):
        # SQLite-only. On Postgres use `RETURNING id` instead.
        return getattr(self._result, "lastrowid", None) if self._result is not None else None

    def close(self):
        pass


class ConnWrapper:
    """Mimics sqlite3.Connection: execute/executemany/cursor/commit/rollback/close, and
    works as a context manager (commit on clean exit, rollback on exception)."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return CursorWrapper(self._conn).execute(sql, params)

    def executemany(self, sql, seq_of_params):
        return CursorWrapper(self._conn).executemany(sql, seq_of_params)

    def cursor(self):
        return CursorWrapper(self._conn)

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is not None:
                self._conn.rollback()
            else:
                self._conn.commit()
        finally:
            self._conn.close()


def connect() -> ConnWrapper:
    """Open a connection with the sqlite3-style surface. Caller commits and closes
    (or use it as a `with` block)."""
    return ConnWrapper(get_engine().connect())


# ─── Convenience helpers (open + use + close internally) ───────────────────────

def query_all(sql, params=()):
    with get_engine().connect() as conn:
        return _rows(conn.execute(text(translate(sql)), build_params(params)))


def query_one(sql, params=()):
    with get_engine().connect() as conn:
        return _one(conn.execute(text(translate(sql)), build_params(params)))


def query_scalar(sql, params=(), default=None):
    row = query_one(sql, params)
    return row[0] if row is not None else default


def execute(sql, params=()):
    """Run a write and commit; returns affected rowcount."""
    with get_engine().begin() as conn:
        return conn.execute(text(translate(sql)), build_params(params)).rowcount


def safe_alter(conn_or_none, ddl: str) -> bool:
    """
    Execute a DDL statement (typically ALTER TABLE ... ADD COLUMN) without
    aborting the surrounding transaction if the column already exists.

    On PostgreSQL: rewrites the statement to use ``IF NOT EXISTS`` syntax,
    e.g. ``ALTER TABLE t ADD COLUMN IF NOT EXISTS col TYPE``. This is a
    completely silent no-op when the column is already present — no server-log
    ERROR, no transaction abort.

    On SQLite: uses a plain try/except (SQLite does not support IF NOT EXISTS
    for ADD COLUMN, but its errors don't abort the transaction anyway).

    Args:
        conn_or_none: Accepted for API compatibility, ignored on Postgres path.
        ddl:          The DDL string, e.g.
                      ``"ALTER TABLE technical_signals ADD COLUMN foo REAL"``

    Returns:
        True  — column was added (or IF NOT EXISTS made it a no-op on PG).
        False — column already existed on SQLite (error silenced).
    """
    if use_postgres():
        # Inject "IF NOT EXISTS" between "ADD COLUMN" and the column name.
        # Works for any case variant of "add column".
        import re as _re
        pg_ddl = _re.sub(
            r"(?i)\bADD\s+COLUMN\b",
            "ADD COLUMN IF NOT EXISTS",
            ddl,
            count=1,
        )
        try:
            with get_engine().begin() as conn:
                conn.execute(text(pg_ddl))
            return True
        except Exception as exc:
            # Fallback: eat any remaining error (e.g., other DDL constraint)
            print(f"[db_compat] safe_alter warning: {exc}")
            return False
    else:
        # SQLite path — simple try/except
        try:
            if conn_or_none is not None:
                conn_or_none.execute(ddl)
            else:
                execute(ddl)
            return True
        except Exception:
            return False


def execute_returning(sql, params=()):
    """Run an INSERT/UPDATE ... RETURNING and commit; returns the first Row (or None)."""
    with get_engine().begin() as conn:
        return _one(conn.execute(text(translate(sql)), build_params(params)))


def executemany(sql, seq_of_params):
    if not seq_of_params:
        return 0
    with get_engine().begin() as conn:
        return conn.execute(
            text(translate(sql)), [build_params(p) for p in seq_of_params]
        ).rowcount


def read_df(sql, params=()):
    """pandas.read_sql wrapper using the active engine + translator."""
    with get_engine().connect() as conn:
        return pd.read_sql(text(translate(sql)), conn, params=build_params(params))


# ─── Transactions ──────────────────────────────────────────────────────────────

class _Tx:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return CursorWrapper(self._conn).execute(sql, params)

    def executemany(self, sql, seq_of_params):
        return CursorWrapper(self._conn).executemany(sql, seq_of_params)

    def query_all(self, sql, params=()):
        return _rows(self._conn.execute(text(translate(sql)), build_params(params)))

    def query_one(self, sql, params=()):
        return _one(self._conn.execute(text(translate(sql)), build_params(params)))


class _TxCtx:
    """Context manager yielding a _Tx; commits on clean exit, rolls back on exception."""

    def __enter__(self):
        self._conn = get_engine().connect()
        self._conn.begin()
        return _Tx(self._conn)

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is not None:
                self._conn.rollback()
            else:
                self._conn.commit()
        finally:
            self._conn.close()
        return False


def transaction():
    return _TxCtx()


# pg_advisory_lock is session-scoped: the unlock MUST run on the exact same physical
# backend connection that took the lock. query_one()/execute() each check a connection
# out of the pool and return it immediately, so a naive acquire-via-query_one +
# release-via-execute pair almost always runs on two different pooled connections —
# the unlock then silently no-ops (that session never held the lock) and the lock stays
# held by whatever connection acquired it, orphaned in the pool until it happens to be
# reused for the same lock name. Pin one checked-out connection per held lock instead.
_advisory_conns: dict = {}


def try_advisory_lock(name: str) -> bool:
    """Best-effort cross-process guard against overlapping cron-script runs.

    Uses a Postgres session-level advisory lock keyed off a stable hash of
    `name`; returns False immediately (non-blocking) if another process
    already holds it. No-op (always True) on SQLite — advisory locks are a
    Postgres-only primitive and the SQLite dev path is single-process.
    """
    if not use_postgres():
        return True
    conn = get_engine().connect()
    try:
        row = conn.execute(text(translate("SELECT pg_try_advisory_lock(?)")), build_params((_advisory_lock_key(name),))).fetchone()
        got = bool(row[0]) if row is not None else False
    except Exception:
        conn.close()
        raise
    if got:
        _advisory_conns[name] = conn
    else:
        conn.close()
    return got


def release_advisory_lock(name: str) -> None:
    if not use_postgres():
        return
    conn = _advisory_conns.pop(name, None)
    if conn is None:
        return
    try:
        conn.execute(text(translate("SELECT pg_advisory_unlock(?)")), build_params((_advisory_lock_key(name),)))
        conn.commit()
    finally:
        conn.close()


def _advisory_lock_key(name: str) -> int:
    import zlib
    return zlib.crc32(name.encode()) & 0x7FFFFFFF


def load_index_map(provider: str) -> dict:
    """Return {provider_id: index_name} for the given provider key.

    Provider keys: 'yahoo', 'mc_ohlc', 'mc_pe', 'mc_oi', 'trendlyne'.
    Falls back to an empty dict if the table doesn't exist yet.
    """
    try:
        rows = query_all(
            "SELECT index_name, provider_id FROM index_provider_map WHERE provider = ?",
            (provider,),
        )
        return {r["provider_id"]: r["index_name"] for r in rows}
    except Exception:
        return {}


def load_index_map_inv(provider: str) -> dict:
    """Return {index_name: provider_id} (inverse of load_index_map)."""
    try:
        rows = query_all(
            "SELECT index_name, provider_id FROM index_provider_map WHERE provider = ?",
            (provider,),
        )
        return {r["index_name"]: r["provider_id"] for r in rows}
    except Exception:
        return {}
