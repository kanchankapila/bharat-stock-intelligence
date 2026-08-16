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
        "schema). Auto-skipped when Postgres is unreachable, so it never breaks a laptop or "
        "a CI lane without the service container.",
    )


# ─── Throwaway Postgres schema ────────────────────────────────────────────────
#
# Phase 2 of docs/SQLITE_DECOMMISSION_PLAN.md needs tests to run against real Postgres rather
# than SQLite, because the SQLite path is structurally incapable of reproducing whole classes of
# bug this repo has actually shipped: NaN is coerced to NULL on insert (so a NaN test passes
# against unfixed code), and STDDEV/DISTINCT ON/NOW() silently fail the entire query instead of
# erroring. Both are recorded in .claude/rules/recurring-bugs.md.
#
# The pattern below already existed, hand-copied into test_nan_recommendation_purge.py and
# test_live_datasource_mc_corporate_calendar.py. This is that pattern made reusable -- a
# conversion should not mean pasting 40 lines of schema plumbing into a third, fourth and
# hundredth file.
#
# ISOLATION IS THE POINT, not convenience. A test pointed at Postgres WITHOUT a private schema
# is pointed at LIVE PRODUCTION -- measured 2026-08-15 when a Postgres-by-default change briefly
# aimed ~100 fixture-building test files at the real database. Nothing was written that time,
# which was luck. Every schema here is uniquely named per test and dropped CASCADE afterwards,
# so a test cannot touch a production table even by accident: an unqualified name resolves
# inside the throwaway schema first.

PG = dict(host="127.0.0.1", port=5433, user="bharat", password="bharat", dbname="bharat_intel")


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


SCHEMA_SQL = pathlib.Path(__file__).resolve().parents[3] / "db" / "schema.postgres.sql"


def _sa_url(schema: str | None = None) -> str:
    """SQLAlchemy URL for the test instance, optionally pinned to a throwaway schema.

    The `options=-c search_path=...` form is what makes the Phase 2 conversion cheap: it pins the
    path on the CONNECTION, so every unqualified name in production code -- not just in the test
    -- resolves inside the throwaway schema. No fetcher or engine needs to know it is under test.
    Exactly what pgClient.getPool() does on the TypeScript side.
    """
    d = _pg_dsn()
    url = f"postgresql+psycopg2://{d['user']}:{quote_plus(d['password'])}@{d['host']}:{d['port']}/{d['dbname']}"
    if schema:
        url += "?options=" + quote_plus(f"-c search_path={schema},public")
    return url


def conn_is_postgres(conn) -> bool:
    """True when `conn` is Postgres-backed, whatever sqlite3.connect appeared to return.

    Several fetchers dialect-branch on `use_postgres()`, and their tests pin it to False to
    exercise the SQLite SQL. Under the decommission shim below, `sqlite3.connect(':memory:')`
    hands back a Postgres ConnWrapper -- so a hardcoded False builds SQLite-only SQL
    (`INSERT OR REPLACE`, `date(x, '-1 day')`) and fires it at Postgres. Keying the branch on
    the CONNECTION instead keeps one test correct under both run modes. The shim is
    unconditional as of 2026-08-16, but only ':memory:' is redirected, so both modes still
    exist within a single run.

    Do not replace this with an env-var read: the shim decides per-connection, not per-process
    (only ':memory:' is redirected; a deliberate temp-file sqlite fixture stays SQLite).
    """
    return type(conn).__name__ == "ConnWrapper"


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
    # public stays on the path so extensions/types resolve, but the throwaway schema is FIRST,
    # so an unqualified name can only ever shadow a production table, never write to one.
    cur.execute(f'SET search_path TO "{schema}", public')
    try:
        yield conn, schema
    finally:
        try:
            cur.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
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
    try:
        _apply_schema(cur, schema)
        cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname = %s", (schema,))
        (n,) = cur.fetchone()
        assert n >= 200, f"throwaway schema {schema} has only {n} tables — DDL did not apply"
        yield schema
    finally:
        try:
            cur.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
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


# ─── The transitional shim: sqlite3.connect(':memory:') IS Postgres inside pytest ──────────
#
# READ THIS BEFORE TRUSTING ANY `sqlite3` CALL IN A TEST.
#
# The project's standing goal is ONE database. Production code and the entire TypeScript suite are
# already Postgres-only. What remained was ~100 pytest files whose fixtures call
# `sqlite3.connect(':memory:')` and then build their own tables.
#
# Converting them one at a time was tried twice and abandoned both times: the files are not
# uniform enough for a codemod, and 100 hand edits is days during which half the suite is still on
# the wrong dialect. So instead of editing 100 call sites, the ONE call they share is redirected:
# inside pytest, `sqlite3.connect(':memory:')` returns a db_compat.ConnWrapper over a private,
# empty Postgres schema. The tests' own CREATE TABLE statements then run against real Postgres,
# unchanged, and every dialect bug those suites were structurally incapable of catching surfaces
# -- which is the point, and is how the TypeScript half found three live production bugs.
#
# WHAT MAKES IT SAFE:
#   * pytest-only. Installed by an autouse fixture here; no real process can reach it.
#   * Schema-isolated. Each test gets its own `t_<uuid>` schema, dropped CASCADE afterwards, so an
#     unqualified write can only shadow a production table, never reach one.
#   * Only ':memory:' is redirected. A deliberate temp-FILE sqlite fixture keeps working.
#
# ALWAYS ON since 2026-08-16. It was gated behind `SQLITE_SHIM_POSTGRES=1` while the dialect bugs
# it surfaced were being fixed -- shipping a red default suite is what data-sources.md warns turns
# CI into noise. That trail closed: 51 -> 46 -> 0 failures, re-measured directly at
# **2,025 passed / 230 skipped / 0 failed** (12m50s), so the flag had no reason to exist and is
# gone. `python -m pytest` now runs the whole suite on Postgres with no opt-in.
#
# WHY IT MUST NOT BECOME PERMANENT: a `sqlite3.connect` that does not return SQLite is surprising,
# and surprising is what this migration exists to end. `pytest_terminal_summary` below prints how
# many files still lean on it (37 at the flip); that number must only go DOWN. At zero, delete
# this block and sql_translate.py's `_in_pytest()` branch together -- at which point
# `postgresOnly.test.ts` and `test_the_two_decision_points_agree_where_they_still_can` both fail
# by design and get updated to assert real parity.

_SHIM_USERS: set = set()
_SHIM_UNAVAILABLE: set = set()


@pytest.fixture(autouse=True)
def _sqlite_is_postgres(request, monkeypatch):
    """Redirect in-memory sqlite3 fixtures onto a throwaway Postgres schema."""
    import sqlite3 as _sqlite3

    real_connect = _sqlite3.connect
    opened: list = []

    def _connect(database=":memory:", *args, **kwargs):
        if str(database) != ":memory:":
            return real_connect(database, *args, **kwargs)
        if not pg_available():
            # Skipping is right for a laptop with no container, but a SILENT skip is the
            # "green while protecting nothing" failure this repo keeps paying for -- so it is
            # counted and reported loudly in the summary below.
            _SHIM_UNAVAILABLE.add(request.node.nodeid.split("::")[0])
            pytest.skip("live Postgres not reachable — set PGTEST_* or start the container")

        _SHIM_USERS.add(request.node.nodeid.split("::")[0])

        import psycopg2
        from sqlalchemy import create_engine, text
        from db_compat import ConnWrapper

        schema = f"t_{uuid.uuid4().hex[:12]}"
        admin = psycopg2.connect(**_pg_dsn())
        admin.autocommit = True
        admin.cursor().execute(f'CREATE SCHEMA "{schema}"')

        engine = create_engine(_sa_url(schema), future=True)
        sa_conn = engine.connect()
        # NO `public` on the path. With it, a table the test never created falls through to
        # the PRODUCTION one -- which is how test_load_regime_edge_status_missing_table_
        # returns_empty_dict read real regime_edge_status rows, and is a write hazard for any
        # test that forgets a CREATE TABLE. Unqualified names now resolve in the throwaway
        # schema or nowhere.
        sa_conn.execute(text(f'SET search_path TO "{schema}"'))
        # translate() consults use_postgres(); this connection IS Postgres regardless of the
        # ambient env var, so force the branch or `?` placeholders reach psycopg2 untranslated.
        monkeypatch.setenv("USE_POSTGRES", "true")
        opened.append((admin, engine, sa_conn, schema))
        return ConnWrapper(sa_conn)

    monkeypatch.setattr(_sqlite3, "connect", _connect)
    yield
    for admin, engine, sa_conn, schema in opened:
        try:
            sa_conn.close()
            engine.dispose()
            admin.cursor().execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        finally:
            admin.close()


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    if _SHIM_USERS:
        terminalreporter.write_line(
            f"[sqlite-decommission] {len(_SHIM_USERS)} test files still reach Postgres through "
            f"the sqlite3.connect shim (see conftest.py). This number must only go down."
        )
    if _SHIM_UNAVAILABLE:
        terminalreporter.write_line(
            f"[sqlite-decommission] WARNING: {len(_SHIM_UNAVAILABLE)} test files were SKIPPED "
            f"because Postgres was unreachable. This run did not test them — a green result here "
            f"means less than it looks. Start the container or set PGTEST_*."
        )


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
