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

# Fixed, arbitrary classid for the two-int pg_advisory_lock() form (see purge_orphan_schemas
# and conftest._pg_session_schema). Distinct from db_compat.try_advisory_lock's single-bigint
# form -- Postgres tags the two forms differently in pg_locks (field2/field3 differ), so this
# cannot collide with a cron-overlap lock even by coincidence.
PG_TEST_SCHEMA_LOCK_NS = 913_070_042


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
    except Exception:
        return False
    # Opportunistic hygiene: reap schemas orphaned by earlier crashed/killed runs (see
    # below). Best-effort only -- a failed sweep never gates availability.
    purge_orphan_schemas()
    return True


def purge_orphan_schemas() -> int:
    """DROP leftover throwaway schemas from crashed/killed pytest runs.

    Why this has to exist: drain_memory_conns()/drop_throwaway_schema() only run when
    teardown executes. A hard crash -- Ctrl-C mid-suite, killed CI worker, closed laptop
    -- skips them, and every t_*/pytest_* schema minted so far stays in the target
    database forever. They hold nothing, but they POLLUTE: any information_schema/
    pg_tables listing that filters on table name alone reads each row once per orphan.
    Measured 2026-08-25: twelve orphans made information_schema.columns report
    index_option_oi's columns twelve times over, which briefly looked like schema drift.

    Widened 2026-08-27 (weekend-audit, AF-20260827-07): this only ever reaped `t_*`
    (pg_schema's own pattern) -- it never covered `pytest_*` (_pg_session_schema's
    pattern, one per pytest SESSION rather than per test), so a killed session-scoped
    run leaked a much larger schema (212 tables) that this sweep could never see. Found
    live: 17 `pytest_*` orphans had accumulated in production, running their own
    compression/retention background jobs and racing the nightly pg_dump backup.

    Safety, corrected 2026-08-27 then 2026-08-28: an EARLIER version of this docstring
    claimed `DROP SCHEMA ... CASCADE` against a schema still in active use always
    raises. That is FALSE, disproved the same session by direct incident: a live
    `pytest_*` session schema was dropped from a separate connection while its own
    pytest run was between statements, with no error -- corrupting that run (see
    AF-20260827-13). The FIRST fix for that (a relation-lock check: skip a name if
    `pg_locks` shows a DIFFERENT backend holding a lock on one of its tables right now)
    was NOT a mitigation -- it was still broken by construction, and reproduced
    DETERMINISTICALLY on every single full-suite run afterward, not rarely. Root
    cause, traced 2026-08-28: a relation lock only exists while a transaction is
    actively open. `_pg_session_schema` applies 400+ DDL statements over an autocommit
    connection (each one's lock releases the instant it commits), then that schema
    sits idle between individual tests for the rest of a run that can last tens of
    minutes -- "no relation lock held right now" is the NORMAL state of a schema very
    much still owned by a live session, not evidence of abandonment. Any OTHER test's
    unrelated `pg_memory_conn()` call anywhere later in the same run triggers this
    sweep and reliably catches that window.

    Fixed for real by checking a SESSION ADVISORY LOCK instead of a relation lock.
    `_pg_session_schema` and `pg_memory_conn()` each take
    `pg_advisory_lock(PG_TEST_SCHEMA_LOCK_NS, hashtext(schema))` on the same connection
    that owns the schema for its whole lifetime -- an advisory lock survives idle gaps
    between statements (it is not tied to any transaction), and is released
    automatically the instant that connection closes or crashes, so it cannot go
    stale the way a hand-rolled "last seen" timestamp could. This is the same
    survives-idle-time property `db_compat.try_advisory_lock` already relies on for
    cross-process cron-overlap guarding (see its own docstring) -- applied here to a
    different question (schema ownership vs. job overlap) with a distinct classid so
    the two can never collide. Only the exact `t_`/`pytest_` + 12-hex patterns THIS
    module mints can match, so a production schema can never collide either. The
    relation-lock check is kept alongside as a second, harmless signal (a schema is
    "in use" if EITHER check says so) -- it just stops being the ONLY signal. A short
    statement_timeout keeps a schema whose leftover connections still hold table locks
    from stalling the sweep indefinitely; the blocked DROP raises, is swallowed, and
    is retried on some later sweep once the blocker exits.

    Returns the number of schemas actually dropped. Every failure is swallowed: this is
    janitorial work called opportunistically from pg_available(), and it must never be
    the reason a test cannot run.
    """
    try:
        import psycopg2

        conn = psycopg2.connect(**_pg_dsn())
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("SET statement_timeout TO '2s'")
        cur.execute(
            "SELECT nspname FROM pg_namespace WHERE nspname ~ '^(t_|pytest_)[0-9a-f]{12}$'"
        )
        names = [r[0] for r in cur.fetchall()]
        # Ownership guard (see docstring): the PRIMARY signal is the session advisory
        # lock the owning connection took at CREATE SCHEMA time -- it survives idle
        # gaps between statements, unlike a relation lock, so it does not falsely flag
        # a schema as orphaned just because nothing is mid-transaction right now.
        cur.execute(
            "SELECT DISTINCT n.nspname FROM pg_namespace n "
            "JOIN pg_locks l ON l.locktype = 'advisory' AND l.classid = %s "
            "  AND l.objid = hashtext(n.nspname)::oid "
            "WHERE l.pid <> pg_backend_pid()",
            (PG_TEST_SCHEMA_LOCK_NS,),
        )
        in_use = {r[0] for r in cur.fetchall()}
        # Relation-lock check kept as a second, harmless signal alongside the advisory
        # lock above -- a schema counts as "in use" if EITHER says so.
        cur.execute(
            "SELECT DISTINCT n.nspname FROM pg_locks l "
            "JOIN pg_class c ON l.relation = c.oid "
            "JOIN pg_namespace n ON c.relnamespace = n.oid "
            "WHERE l.pid <> pg_backend_pid()"
        )
        in_use |= {r[0] for r in cur.fetchall()}
        dropped = 0
        for name in names:
            if name in in_use:
                continue
            try:
                cur.execute(f'DROP SCHEMA "{name}" CASCADE')
                dropped += 1
            except Exception:
                pass  # locked (another process's live schema) or already gone: skip
        conn.close()
        return dropped
    except Exception:
        return 0


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
    admin_cur = admin.cursor()
    admin_cur.execute(f'CREATE SCHEMA "{schema}"')
    # See purge_orphan_schemas: a session advisory lock, not a relation lock, is what proves
    # this schema is still owned by a live backend once the test's own DML goes idle.
    admin_cur.execute("SELECT pg_advisory_lock(%s, hashtext(%s))", (PG_TEST_SCHEMA_LOCK_NS, schema))

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
