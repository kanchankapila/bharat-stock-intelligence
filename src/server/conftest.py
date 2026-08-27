import os
import pathlib
import uuid
from urllib.parse import quote_plus

import pytest


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "live_datasource: hits a real external API/URL for one real ticker/screener and "
        "checks the response + DB storage. Skipped by default (network-dependent, not run "
        "in CI) — opt in with RUN_LIVE_DATASOURCE_TESTS=1.",
    )
    config.addinivalue_line(
        "markers",
        "postgres: needs a real Postgres instance (uses the `pg_schema` fixture's throwaway "
        "schema). Skipped INDIVIDUALLY when Postgres is unreachable so the output stays "
        "readable, but the RUN then exits non-zero -- see pytest_sessionfinish. A skipped "
        "test is not a passed one.",
    )


# ─── Throwaway Postgres schema ──────────────────────────────
#
# Phase 2 of docs/SQLITE_DECOMMISSION_PLAN.md needs tests to run against real Postgres rather
# than SQLite, because the SQLite path is structurally incapable of reproducing whole classes of
# bug this repo has actually shipped: NaN is coerced to NULL on insert (so a NaN test passes
# against unfixed code), and STDDEV/DISTINCT ON/NOW() silently fail the entire query instead of
# erroring. Both are recorded in .claude/rules/recurring-bugs.md.
#
# The connection plumbing lives in pg_test_support (a UNIQUE module name -- see its docstring
# for why `from conftest import ...` is not safe here); this file owns the pytest surface.

from pg_test_support import (  # noqa: E402
    PG,
    PG_TEST_SCHEMA_LOCK_NS,
    SCHEMA_SQL,
    _MEM_NODE,
    _PG_UNAVAILABLE,
    _pg_dsn,
    _sa_url,
    drain_memory_conns,
    drop_throwaway_schema,
    pg_available,
    pg_memory_conn,  # noqa: F401  -- re-exported for tests that import it from conftest
)


def conn_is_postgres(conn) -> bool:
    """True when `conn` is Postgres-backed.

    Several fetchers dialect-branch on `use_postgres()`, and their tests pin it to False to
    exercise the SQLite SQL -- but a `pg_memory_conn()` fixture hands back a Postgres
    ConnWrapper, so a hardcoded False would build SQLite-only SQL (`INSERT OR REPLACE`,
    `date(x, '-1 day')`) and fire it at Postgres. Keying the branch on the CONNECTION keeps
    one test correct whichever fixture built it.

    Do not replace this with an env-var read: the answer is per-connection, not per-process --
    five test files still use a deliberate temp-FILE sqlite fixture (see
    docs/SQLITE_DECOMMISSION_PLAN.md's "What is left").
    """
    return type(conn).__name__ == "ConnWrapper"


@pytest.fixture
def pg_schema():
    """Yield (connection, schema_name) for a private, empty Postgres schema.

    The connection's search_path is pinned to the throwaway schema, so unqualified CREATE
    TABLE / INSERT / SELECT in a test land there and never in `public`. Dropped CASCADE on
    teardown even if the test fails.

    Usage:
        def test_something(pg_schema):
            conn, schema = pg_schema
            cur = conn.cursor()
            cur.execute("CREATE TABLE unified_recommendations (symbol TEXT, ...)")
    """
    psycopg2 = pytest.importorskip("psycopg2")
    if not pg_available():
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")

    # uuid4, not the test name: names collide across xdist workers and repeated runs, and a
    # leftover schema from a killed run would otherwise be silently reused as if it were empty.
    schema = f"t_{uuid.uuid4().hex[:12]}"
    conn = psycopg2.connect(**_pg_dsn())
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(f'CREATE SCHEMA "{schema}"')
    # See purge_orphan_schemas: claim ownership for this connection's whole lifetime before
    # this schema has any table (and hence any relation lock) of its own -- the window between
    # CREATE SCHEMA and the test's first CREATE TABLE is exactly the gap a lock-only orphan
    # check misreads as abandoned, and this fixture's schema sits in that gap the whole time
    # a test body hasn't run its own DDL yet.
    cur.execute("SELECT pg_advisory_lock(%s, hashtext(%s))", (PG_TEST_SCHEMA_LOCK_NS, schema))
    # public stays on the path so extensions/types resolve, but the throwaway schema is FIRST,
    # so an unqualified name can only ever shadow a production table, never write to one.
    cur.execute(f'SET search_path TO "{schema}", public')
    try:
        yield conn, schema
    finally:
        try:
            drop_throwaway_schema(conn, schema)
        finally:
            conn.close()


@pytest.fixture
def pg_conn(pg_schema):
    """Like `pg_schema`, but wraps the connection in db_compat.ConnWrapper -- the same
    sqlite3.Connection-shaped surface (execute/executemany/cursor/commit/rollback) that every
    fetcher's `conn` parameter already expects.

    This is what makes a Phase 2 conversion a ONE-LINE fixture swap rather than a rewrite: a
    function written against `?` placeholders and `ON CONFLICT` still works unmodified, because
    ConnWrapper is production's own translation layer, not test-only shimming. Postgres-specific
    behaviour (e.g. a real `ON CONFLICT DO UPDATE`, a real multi-row upsert) is exercised for
    real, which the bare-sqlite3 fixture it replaces could not do -- SQLite accepts the same
    `ON CONFLICT` syntax but is not the dialect production actually runs.

    Usage: identical to a raw sqlite3.connect(':memory:') swapped 1:1 -- test bodies calling
    the function under test don't change at all, only how the connection is constructed.
    """
    # ConnWrapper wraps a SQLAlchemy Connection (that is what production's own db_compat.connect()
    # passes it), not a raw psycopg2 connection -- `pg_schema` deliberately stays psycopg2-based
    # for tests that want plain SQL, so this fixture opens its own SQLAlchemy connection into the
    # SAME throwaway schema `pg_schema` already created, rather than trying to reuse the DBAPI
    # object across two different client libraries.
    #
    # translate() reads use_postgres() (== os.environ["USE_POSTGRES"] inside pytest, per
    # sql_translate.py's Postgres-only guarantee) to decide whether to apply PG-only
    # function/syntax mapping. This fixture IS a real Postgres connection regardless of the
    # ambient env var, so it must force that branch for its own lifetime -- otherwise `?`
    # placeholders reach psycopg2 untranslated and every query fails. Restored on teardown so
    # this fixture can't leak the dialect into an unrelated test that runs afterward.
    from sqlalchemy import create_engine, text
    from db_compat import ConnWrapper

    _, schema = pg_schema
    dsn = _pg_dsn()
    url = f"postgresql+psycopg2://{dsn['user']}:{dsn['password']}@{dsn['host']}:{dsn['port']}/{dsn['dbname']}"
    engine = create_engine(url, future=True)
    sa_conn = engine.connect()
    sa_conn.execute(text(f'SET search_path TO "{schema}", public'))

    previous = os.environ.get("USE_POSTGRES")
    os.environ["USE_POSTGRES"] = "true"
    try:
        yield ConnWrapper(sa_conn)
    finally:
        if previous is None:
            os.environ.pop("USE_POSTGRES", None)
        else:
            os.environ["USE_POSTGRES"] = previous
        sa_conn.close()
        engine.dispose()


# ─── Full production schema in a throwaway schema (Phase 2, 2026-08-16) ───────
#
# `pg_schema`/`pg_conn` above hand a test an EMPTY schema, so each one still builds the tables it
# needs. That is the right tool for most conversions, because the existing fixtures do bare
# `INSERT ... VALUES (?, ?, ?)` with no column list, which only lines up against a table of
# exactly the width the test declared.
#
# `pg_db` is for the other case: it applies db/schema.postgres.sql -- generated FROM live -- once
# per session, so a converted test can delete its own DDL entirely and assert against the real
# production shape. Hand-rolled DDL is how db.ts's schema-of-record drifted from production and
# hid three live bugs (see .claude/rules/recurring-bugs.md).


def _apply_schema(cur, schema: str) -> None:
    ddl = SCHEMA_SQL.read_text(encoding="utf-8")
    # schema.postgres.sql qualifies its 219 index statements `ON public.foo` while leaving every
    # CREATE TABLE unqualified. Applied as-is with search_path elsewhere it creates the tables
    # here and then indexes the REAL production tables -- caught on the TypeScript side the first
    # time globalSetup ran it. Rewrite, then assert nothing survived.
    ddl = ddl.replace("public.", f'"{schema}".')
    assert "public." not in ddl, "schema rewrite missed a public.-qualified reference"
    cur.execute(f'SET search_path TO "{schema}", public')
    cur.execute(ddl)


@pytest.fixture(scope="session")
def _pg_session_schema():
    """One throwaway schema holding the whole production schema, for the entire session.

    Session-scoped because applying 212 tables + 219 indexes costs seconds; per-test isolation
    comes from `pg_db` truncating rather than recreating.
    """
    psycopg2 = pytest.importorskip("psycopg2")
    if not pg_available():
        pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")

    schema = f"pytest_{uuid.uuid4().hex[:12]}"
    conn = psycopg2.connect(**_pg_dsn())
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(f'CREATE SCHEMA "{schema}"')
    # Claim ownership for this connection's whole lifetime (see purge_orphan_schemas'
    # matching check) -- a session advisory lock survives idle/no-transaction gaps
    # between DDL/DML statements, unlike a relation lock. `_apply_schema` below runs
    # 400+ individually-autocommitted statements, and this schema then sits idle
    # between every later test that uses it -- a relation-lock-only "in use" check
    # reads either state as orphaned and reaps its own owning session's schema.
    cur.execute("SELECT pg_advisory_lock(%s, hashtext(%s))", (PG_TEST_SCHEMA_LOCK_NS, schema))
    try:
        _apply_schema(cur, schema)
        cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname = %s", (schema,))
        (n,) = cur.fetchone()
        assert n >= 200, f"throwaway schema {schema} has only {n} tables — DDL did not apply"
        yield schema
    finally:
        try:
            drop_throwaway_schema(conn, schema)
        finally:
            conn.close()


@pytest.fixture
def pg_db(_pg_session_schema, monkeypatch):
    """Point db_compat's engine at the throwaway schema, empty, for one test.

    Production code under test needs no changes: it calls `get_engine()`/`connect()`, which
    resolve `POSTGRES_URL`, which this fixture rewrites to carry the search_path. db_compat caches
    engines per-URL, so the test URL and any real one never share a pool.
    """
    psycopg2 = pytest.importorskip("psycopg2")
    schema = _pg_session_schema

    conn = psycopg2.connect(**_pg_dsn())
    conn.autocommit = True
    cur = conn.cursor()
    # `%%I` -- a literal % must be doubled in a psycopg2 query that also carries a %s parameter,
    # or the driver reads `%I` as a placeholder and raises "tuple index out of range".
    # recurring-bugs.md's "raw % placeholder" entry, hit while writing this fixture.
    cur.execute(
        "SELECT string_agg(format('%%I.%%I', schemaname, tablename), ', ') "
        "FROM pg_tables WHERE schemaname = %s",
        (schema,),
    )
    (tables,) = cur.fetchone()
    if tables:
        cur.execute(f"TRUNCATE {tables} RESTART IDENTITY CASCADE")
    conn.close()

    monkeypatch.setenv("USE_POSTGRES", "true")
    monkeypatch.setenv("POSTGRES_URL", _sa_url(schema))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    yield schema


@pytest.fixture
def pg_db_conn(pg_db):
    """`pg_db` plus an open db_compat connection into it — the 1:1 replacement for a test's
    `sqlite3.connect(':memory:')`, with the production schema already present."""
    import db_compat

    conn = db_compat.connect()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            pass


@pytest.fixture(autouse=True)
def _pg_memory_lifecycle(request):
    """Name the current test for skip reporting, and drop every schema it opened."""
    _MEM_NODE["id"] = request.node.nodeid.split("::")[0]
    yield
    drain_memory_conns()


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    if _PG_UNAVAILABLE:
        terminalreporter.write_line(
            f"[sqlite-decommission] FAILING THIS RUN: {len(_PG_UNAVAILABLE)} test files were "
            f"SKIPPED because Postgres was unreachable, so this run did not test them. "
            f"Start the container or set PGTEST_*."
        )


def pytest_sessionfinish(session, exitstatus):
    """Refuse to exit 0 when tests were skipped because Postgres was unreachable.

    A printed WARNING is not enough. CI, git hooks, and `verify-gate.mjs` read the EXIT CODE,
    so a run that skipped 90 files for want of a database still reported success -- the exact
    "green while protecting nothing" failure this repo keeps paying for, reintroduced by the
    very mechanism meant to guard against it.

    vitest already gets this right: `vitest.globalSetup.ts` THROWS when it cannot reach
    Postgres, so the unit project cannot silently degrade. pytest was the odd one out, and the
    asymmetry was the bug -- same repo, same hard requirement, two different answers.

    Deliberately keyed on `_PG_UNAVAILABLE` (populated only when a test actually asked for a
    connection and could not get one) rather than probing at session start: a run of tests that
    never touch a database should still pass on a machine with no container.
    """
    if _PG_UNAVAILABLE and exitstatus == 0:
        session.exitstatus = 1


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_LIVE_DATASOURCE_TESTS") == "1":
        return
    skip_live = pytest.mark.skip(
        reason="live_datasource test skipped — set RUN_LIVE_DATASOURCE_TESTS=1 to run "
               "(hits a real external URL, not run by default or in CI)"
    )
    for item in items:
        if "live_datasource" in item.keywords:
            item.add_marker(skip_live)
