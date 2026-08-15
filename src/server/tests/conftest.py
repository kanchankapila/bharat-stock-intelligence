import os
import uuid

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
