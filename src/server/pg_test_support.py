"""Throwaway-Postgres-schema plumbing for the pytest suite.

Why this is a module and not just conftest.py: `from conftest import ...` is AMBIGUOUS once
more than one test directory is collected in the same run. `src/server/` and `tests/chatbot/`
both hold a conftest.py, and every test file inserts its own directory onto sys.path, so
`import conftest` resolves to whichever landed first. `tests/chatbot/_pg_support.py` already
documents this exact trap after hitting it. `pg_test_support` is a name no other module in the
repo uses, so a test file's import resolves here regardless of sys.path order.

conftest.py imports from this module and owns the pytest-facing surface (fixtures, hooks).
"""

import os
import pathlib
import uuid
from urllib.parse import quote_plus

import pytest

# ─── Where the test Postgres lives ────────────────────────────────────────────
#
# ISOLATION IS THE POINT, not convenience. A test pointed at Postgres WITHOUT a private schema
# is pointed at LIVE PRODUCTION -- measured 2026-08-15 when a Postgres-by-default change briefly
# aimed ~100 fixture-building test files at the real database. Nothing was written that time,
# which was luck. Every schema handed out here is uniquely named per test and dropped CASCADE
# afterwards, so a test cannot touch a production table even by accident: an unqualified name
# resolves inside the throwaway schema first.

PG = dict(host="127.0.0.1", port=5433, user="bharat", password="bharat", dbname="bharat_intel")

SCHEMA_SQL = pathlib.Path(__file__).resolve().parents[2] / "db" / "schema.postgres.sql"
assert SCHEMA_SQL.exists(), f"schema.postgres.sql not found at {SCHEMA_SQL}"


def _pg_dsn() -> dict:
    """Connection settings, env-overridable so CI's service container works unchanged.

    Deliberately NOT read from POSTGRES_URL: these tests must target whatever instance the
    runner provides, and a stray production URL in the environment should not silently redirect
    a schema-creating test at it.
    """
    return dict(
        host=os.environ.get("PGTEST_HOST", PG["host"]),
        port=int(os.environ.get("PGTEST_PORT", PG["port"])),
        user=os.environ.get("PGTEST_USER", PG["user"]),
        password=os.environ.get("PGTEST_PASSWORD", PG["password"]),
        dbname=os.environ.get("PGTEST_DB", PG["dbname"]),
    )


def _sa_url(schema: str | None = None) -> str:
    """SQLAlchemy URL for the test instance, optionally pinned to a throwaway schema.

    The `options=-c search_path=...` form is what makes a Phase 2 conversion cheap: it pins the
    path on the CONNECTION, so every unqualified name in production code -- not just in the test
    -- resolves inside the throwaway schema. No fetcher or engine needs to know it is under test.
    Exactly what pgClient.getPool() does on the TypeScript side.
    """
    d = _pg_dsn()
    url = f"postgresql+psycopg2://{d['user']}:{quote_plus(d['password'])}@{d['host']}:{d['port']}/{d['dbname']}"
    if schema:
        url += "?options=" + quote_plus(f"-c search_path={schema},public")
    return url


def pg_available() -> bool:
    try:
        import psycopg2
    except ImportError:
        return False
    try:
        psycopg2.connect(connect_timeout=3, **_pg_dsn()).close()
        return True
    except Exception:
        return False


# ─── pg_memory_conn(): what this suite uses instead of sqlite3.connect(':memory:') ─────────
#
# The project's standing goal is ONE database. Production code and the entire TypeScript suite
# are Postgres-only; what remained was ~93 pytest files whose fixtures called
# `sqlite3.connect(':memory:')` and then built their own tables.
#
# Those files were converted (2026-08-17) to call `pg_memory_conn()` instead. It returns a
# db_compat.ConnWrapper over a private, empty Postgres schema, so a fixture's own CREATE TABLE
# statements run against real Postgres unchanged and every dialect bug those suites were
# structurally incapable of catching surfaces -- which is how the TypeScript half found three
# live production bugs, and how this conversion found a fourth (see db_compat's
# `_usable_after_failure`).
#
# THIS REPLACED A MONKEYPATCH that made `sqlite3.connect(':memory:')` itself return Postgres.
# The redirect worked and got the dialect trail to zero failures, but a `sqlite3.connect` that
# does not return SQLite is exactly the "which dialect am I on" surprise this migration exists
# to END, so the call sites now say what they mean. Do not reintroduce the monkeypatch, and do
# not add a new `sqlite3.connect(':memory:')` -- use this helper, `pg_conn` (empty schema) or
# `pg_db_conn` (full production schema).

_MEM_OPEN: list = []
_MEM_NODE: dict = {"id": "?"}
_PG_UNAVAILABLE: set = set()


def pg_memory_conn():
    """A throwaway-Postgres-schema connection with a sqlite3.Connection-shaped API.

    The 1:1 replacement for `sqlite3.connect(':memory:')`: a test body calling the function
    under test does not change at all, because ConnWrapper is production's own translation
    layer -- `?` placeholders and `ON CONFLICT` keep working, now against the dialect
    production actually runs.

    Deliberately a plain function rather than a fixture: most call sites sit inside a module-
    level `make_db()`-style helper, and threading a fixture through those would have meant
    rewriting signatures across 93 files instead of swapping one expression.

    Cleanup (schema drop, env restore) is done by conftest's autouse `_pg_memory_lifecycle`.
    """
    if not pg_available():
        # Skipping is right for a laptop with no container, but a SILENT skip is the "green
        # while protecting nothing" failure this repo keeps paying for -- so it is counted and
        # reported loudly in conftest's pytest_terminal_summary.
        _PG_UNAVAILABLE.add(_MEM_NODE["id"])
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")

    import psycopg2
    from sqlalchemy import create_engine, text
    from db_compat import ConnWrapper

    schema = f"t_{uuid.uuid4().hex[:12]}"
    admin = psycopg2.connect(**_pg_dsn())
    admin.autocommit = True
    admin.cursor().execute(f'CREATE SCHEMA "{schema}"')

    engine = create_engine(_sa_url(schema), future=True)
    sa_conn = engine.connect()
    # NO `public` on the path. With it, a table the test never created falls through to the
    # PRODUCTION one -- which is how test_load_regime_edge_status_missing_table_returns_empty_dict
    # read real regime_edge_status rows, and is a write hazard for any test that forgets a
    # CREATE TABLE. Unqualified names now resolve in the throwaway schema or nowhere.
    sa_conn.execute(text(f'SET search_path TO "{schema}"'))
    # translate() consults use_postgres(); this connection IS Postgres regardless of the ambient
    # env var, so force the branch or `?` placeholders reach psycopg2 untranslated.
    previous = os.environ.get("USE_POSTGRES")
    os.environ["USE_POSTGRES"] = "true"
    _MEM_OPEN.append((admin, engine, sa_conn, schema, previous))
    return ConnWrapper(sa_conn)


def drop_throwaway_schema(admin, schema: str) -> None:
    """DROP a throwaway test schema, evicting anything still holding locks inside it first.

    Why the eviction is required and not paranoia (measured live 2026-08-21): a test body that
    opens a connection and never closes it leaves it `idle in transaction` holding
    AccessShareLocks on that schema's tables. `DROP SCHEMA ... CASCADE` needs
    AccessExclusiveLock, so it waits behind them -- observed at 5-10 MINUTES per test, which is
    what made the Python suite look like it was stalling on "memory pressure" while free RAM was
    5.4/23 GB. `db_compat.dispose_engines()` is the graceful half and should still be called
    first, but it is NOT sufficient on its own: SQLAlchemy's Engine.dispose() replaces the pool
    and deliberately does NOT close connections that are still checked out, which is exactly the
    leaked-connection case.

    Terminating is safe here precisely because the schema is a per-test uuid: any backend
    holding a lock on a relation inside it is, by construction, this test's own leftover.
    """
    cur = admin.cursor()
    cur.execute(
        """
        SELECT pg_terminate_backend(l.pid)
        FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = %s AND l.pid <> pg_backend_pid()
        """,
        (schema,),
    )
    cur.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')


def drain_memory_conns() -> None:
    """Drop every schema pg_memory_conn() opened, restoring USE_POSTGRES in reverse order."""
    while _MEM_OPEN:
        admin, engine, sa_conn, schema, previous = _MEM_OPEN.pop()
        try:
            if previous is None:
                os.environ.pop("USE_POSTGRES", None)
            else:
                os.environ["USE_POSTGRES"] = previous
            sa_conn.close()
            engine.dispose()
            drop_throwaway_schema(admin, schema)
        finally:
            admin.close()
