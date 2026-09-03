"""
PostgreSQL-only data-access layer for the Python engines (Phase 3 / P3f).

The Python analog of the TypeScript `dbAsync` facade. Exposes a small synchronous API
(connect / query_all / query_one / query_scalar / execute / executemany / transaction /
read_df / get_engine) backed exclusively by PostgreSQL via SQLAlchemy + psycopg2.

Everything executes through a SQLAlchemy `text()` connection so dialect/paramstyle
differences are handled by SQLAlchemy and the sql_translate translator. Rows are returned
as a `Row` (a dict subclass) that supports BOTH name access (row['col']) and positional
access (row[0]), matching the sqlite3.Row surface the engines already rely on.

Conversion notes for P3f:
  - Pass parameters as a positional tuple/list: query_all(sql, [a, b]).
  - For an inserted id on Postgres, add `RETURNING id` and read it.
  - SQLite-only SQL (INSERT OR REPLACE, strftime, PRAGMA table_info) must be hand-converted.
"""
import os
from contextlib import contextmanager
from datetime import datetime, timezone
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
    from sql_translate import translate, build_params
except ImportError:  # pragma: no cover
    from .sql_translate import translate, build_params


# PostgreSQL is the only database (SQLite fully decommissioned 2026-08-16).
# ~30 Python engines still `from db_compat import use_postgres`; this shim keeps them
# working and reads as the cleared-for-takeoff signal. Both URL resolution and every
# query path are hard-wired to Postgres — this symbol is a compatibility no-op.
def use_postgres() -> bool:
    return True


# AF-20260831-04: psycopg2 casts a native DATE column to a Python datetime.date object by
# default, but every caller here (and its predecessor, the pre-2026-08-16 SQLite path) has
# always received a plain 'YYYY-MM-DD' string -- a datetime.date breaks any code doing
# string slicing/comparison on the value, and json.dumps() raises on it outright
# ("Object of type date is not JSON serializable"). pgClient.ts already registers the
# mirror-image override (types.setTypeParser(types.builtins.DATE, val => val)) for exactly
# this reason. Registered globally (not per-engine/per-connection) so it applies to every
# psycopg2 connection this process opens, matching that TS-side scope. 1082 is Postgres's
# well-known builtin OID for the `date` type (stable across versions, not schema-dependent).
import psycopg2 as _psycopg2  # noqa: E402
_DATE_OID = 1082
_DATE_AS_STR = _psycopg2.extensions.new_type((_DATE_OID,), "DATE_AS_STR", lambda value, cursor: value)
_psycopg2.extensions.register_type(_DATE_AS_STR)


# --- Connection URL / engine ---


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
    return _pg_url()


_engines: dict = {}


def get_engine():
    """Cached SQLAlchemy Engine for the active dialect (one per resolved URL/process)."""
    url = database_url()
    eng = _engines.get(url)
    if eng is None:
        eng = create_engine(url, pool_pre_ping=True, future=True)
        _engines[url] = eng
    return eng


def dispose_engines() -> None:
    """Close every pooled connection and clear the engine cache.

    A fixture that repoints POSTGRES_URL at a throwaway schema MUST call this BEFORE its
    `DROP SCHEMA ... CASCADE`. Pooled connections opened against that schema hold
    AccessShareLocks on its tables; DROP SCHEMA needs AccessExclusiveLock, so it blocks
    behind them for as long as the pool keeps them alive -- measured 2026-08-21 at 5-10
    minutes per test, which is what made the Python suite look like it was stalling under
    "memory pressure" when it was really waiting on a lock (free RAM was 5.4/23 GB).

    `importlib.reload(db_compat)` does NOT do this: it rebinds the module and abandons the
    old `_engines` dict with its sockets still open and its transactions still idle.
    """
    for eng in _engines.values():
        try:
            eng.dispose()
        except Exception:  # best-effort teardown: a dead socket must not fail the fixture
            pass
    _engines.clear()


# â”€â”€â”€ Row: dual-access (name + positional) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    def __eq__(self, other):
        # sqlite3.Row compares equal to a plain tuple of its values, and ~10 pytest files
        # assert `row == ('SYM', 1416.5)`. Without this they see a dict and fail on a
        # difference that is purely how the row is spelled, not what it holds.
        if isinstance(other, (tuple, list)):
            return self._values == tuple(other)
        return super().__eq__(other)

    def __ne__(self, other):
        return not self.__eq__(other)

    __hash__ = None  # matches dict: unhashable


def _rows(result):
    cols = list(result.keys())
    return [Row(cols, tuple(r)) for r in result.fetchall()]


def _one(result):
    cols = list(result.keys())
    r = result.fetchone()
    return Row(cols, tuple(r)) if r is not None else None


# â”€â”€â”€ Cursor / connection wrappers (legacy sqlite3 surface) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class _EmptyResult:
    """Stand-in for a SQLAlchemy CursorResult when executemany() is called with zero
    rows â€” sqlite3 treats that as a no-op, but passing an empty list to
    Connection.execute() makes SQLAlchemy compile a single no-params execution instead
    of "executemany with 0 iterations", raising a spurious missing-bind-parameter error."""
    rowcount = 0

    def fetchone(self):
        return None

    def fetchall(self):
        return []

    def keys(self):
        return []


def _transaction_is_aborted(conn) -> bool:
    """True only when Postgres has put this connection's transaction in the error state.

    Asking the driver rather than inferring it from the exception is what keeps the rollback
    below safe. A statement can fail WITHOUT aborting anything -- translate() rejecting
    `INSERT OR REPLACE`, build_params() choking on a bad argument, any Python-side error before
    the server is reached. In those cases the caller's pending work is still perfectly
    committable, and rolling back would destroy it.
    """
    try:
        import psycopg2.extensions as _ext

        raw = conn.connection.dbapi_connection
        return raw.info.transaction_status == _ext.TRANSACTION_STATUS_INERROR
    except Exception:                                            # noqa: BLE001
        return False


@contextmanager
def _usable_after_failure(conn):
    """Roll back an ABORTED transaction so the connection survives it, then re-raise.

    sqlite3 -- the API this module mimics, and the API every engine here was written against --
    leaves a connection perfectly usable after a statement errors. Postgres does not: ONE failed
    statement aborts the whole transaction, and every subsequent query returns
    InFailedSqlTransaction until someone rolls back.

    That difference silently breaks the `try: ... except Exception: print(...)` degrade-gracefully
    pattern this codebase uses everywhere (unified_ranker.py alone has 33). On SQLite each
    swallowed error is local, and the run continues with partial data exactly as the surrounding
    docstrings promise. On Postgres the FIRST one kills the connection, so every later read fails
    too -- and because those are swallowed as well, the job reports success having read almost
    nothing. Measured 2026-08-17: one missing advisory table made unified_ranker classify its
    entire universe as Hold with 0 bull/bear counts, printing 10 "unavailable" lines and exit 0.

    `recurring-bugs.md` warns that a rollback inside a SHARED helper can discard a caller's
    pending work. That warning is why this is gated on `_transaction_is_aborted()` rather than on
    "an exception happened": once Postgres has aborted the transaction, the earlier statements in
    it can never commit, so the rollback destroys nothing that was not already lost -- and when
    the transaction is NOT aborted, nothing happens at all. It never suppresses the error either;
    the caller still sees it.
    """
    try:
        yield
    except Exception:
        if _transaction_is_aborted(conn):
            try:
                conn.rollback()
            except Exception:                                    # noqa: BLE001
                pass
        raise


class CursorWrapper:
    """Mimics the subset of sqlite3.Cursor the engines use: execute/executemany +
    fetchone/fetchall + rowcount/lastrowid."""

    def __init__(self, conn):
        self._conn = conn
        self._result = None

    def execute(self, sql, params=()):
        with _usable_after_failure(self._conn):
            self._result = self._conn.execute(text(translate(sql)), build_params(params))
        return self

    def executemany(self, sql, seq_of_params):
        if not seq_of_params:
            self._result = _EmptyResult()
            return self
        with _usable_after_failure(self._conn):
            self._result = self._conn.execute(
                text(translate(sql)), [build_params(p) for p in seq_of_params]
            )
        return self

    def fetchone(self):
        return _one(self._result) if self._result is not None else None

    def fetchall(self):
        return _rows(self._result) if self._result is not None else []

    def __iter__(self):
        # sqlite3.Cursor is iterable, and call sites rely on it: `for r in conn.execute(...)`.
        return iter(self.fetchall())

    @property
    def description(self):
        # DB-API 2.0 7-tuple per column; pandas.read_sql_query reads col[0] (the name) off this
        # when handed a raw DBAPI connection rather than a SQLAlchemy connectable.
        if self._result is None:
            return None
        return [(k, None, None, None, None, None, None) for k in self._result.keys()]

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

    def executescript(self, script: str):
        """Run a multi-statement script, mirroring sqlite3.Connection.executescript.

        SQLAlchemy/psycopg2 accept only one statement per execute(), so a script has to be
        split. Added 2026-08-16 for SQLITE_DECOMMISSION_PLAN Phase 2: it was the single
        largest blocker to moving the pytest suite off SQLite (18 of 44 unconvertible files
        used it and nothing else).

        The split is naive on purpose -- semicolons outside quotes, comments stripped -- which
        is sufficient for the schema-setup scripts this is used for and is NOT a SQL parser.
        Do not feed it statements containing a semicolon inside a dollar-quoted body
        (PL/pgSQL, DO blocks); those need conn.execute() one at a time.
        """
        import re as _re

        cleaned = _re.sub(r"--[^\n]*", "", script)
        out, buf, quote = [], [], None
        for ch in cleaned:
            if quote:
                buf.append(ch)
                if ch == quote:
                    quote = None
                continue
            if ch in ("'", '"'):
                quote = ch
                buf.append(ch)
                continue
            if ch == ";":
                stmt = "".join(buf).strip()
                if stmt:
                    out.append(stmt)
                buf = []
                continue
            buf.append(ch)
        tail = "".join(buf).strip()
        if tail:
            out.append(tail)

        cur = CursorWrapper(self._conn)
        for stmt in out:
            cur.execute(stmt)
        return cur

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


# â”€â”€â”€ Convenience helpers (open + use + close internally) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def now_utc_iso() -> str:
    """Timezone-aware UTC timestamp string, safe to write into any TIMESTAMPTZ column.

    Live-audit finding 2026-08-09: many engines write `datetime.datetime.now().isoformat()`
    (naive, local system clock) into TIMESTAMPTZ columns. The Postgres session's own TimeZone
    GUC is UTC, so an offset-less string is taken to already BE UTC -- on a box whose local
    clock is IST (UTC+5:30), that silently stores the wall-clock IST reading ~5.5h ahead of
    true UTC (confirmed live: model_registry.trained_at read as being in the future relative
    to Postgres now()). Use this instead of a bare `datetime.now().isoformat()` anywhere the
    target column is TIMESTAMPTZ -- the explicit '+00:00' offset makes Postgres's parser
    correct regardless of the writing process's local timezone.
    """
    return datetime.now(timezone.utc).isoformat()


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
    completely silent no-op when the column is already present â€” no server-log
    ERROR, no transaction abort.

    Args:
        conn_or_none: Accepted for API compatibility, ignored (Postgres-only).
        ddl:          The DDL string, e.g.
                      ``"ALTER TABLE technical_signals ADD COLUMN foo REAL"``

    Returns:
        True  â€” column was added (or IF NOT EXISTS made it a no-op on PG).
        False â€” the DDL still failed after IF NOT EXISTS (warning printed).
    """
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


# â”€â”€â”€ Transactions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
# release-via-execute pair almost always runs on two different pooled connections â€”
# the unlock then silently no-ops (that session never held the lock) and the lock stays
# held by whatever connection acquired it, orphaned in the pool until it happens to be
# reused for the same lock name. Pin one checked-out connection per held lock instead.
_advisory_conns: dict = {}


def try_advisory_lock(name: str) -> bool:
    """Best-effort cross-process guard against overlapping cron-script runs.

    Uses a Postgres session-level advisory lock keyed off a stable hash of
    `name`; returns False immediately (non-blocking) if another process
    already holds it.
    """
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
