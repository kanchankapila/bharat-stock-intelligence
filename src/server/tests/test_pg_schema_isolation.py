"""A throwaway-schema fixture must not let an unqualified name reach production.

Live incident 2026-09-17: a `pg_conn` test ran
`ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS fcf_yield_approx ...`.
Its schema held only the 2 tables the test created, so the unqualified name fell
through `public` and took an ACCESS EXCLUSIVE lock on PRODUCTION
public.technical_signals -- behind the nightly pg_dump, which stalled every
reader of the platform's main feature table until the backup finished.

`pg_memory_conn` already omits `public` for exactly this reason (see
pg_test_support.py); `pg_schema` did not, and its comment claimed
"schema FIRST, so an unqualified name can only ever shadow a production table,
never write to one" -- true only for a name the schema actually has.
"""
import pathlib
import pytest


def test_pg_schema_search_path_excludes_public(pg_schema):
    """Negative control: with `public` on the path this returns '...,public' and fails."""
    conn, schema = pg_schema
    cur = conn.cursor()
    cur.execute("SHOW search_path")
    path = cur.fetchone()[0]
    assert "public" not in path, (
        f"search_path={path!r} still contains public -- an unqualified name for a table "
        f"this test never created resolves to the PRODUCTION table"
    )


def test_unqualified_production_table_is_unreachable(pg_schema):
    """The functional half: production-only tables must not resolve at all."""
    conn, schema = pg_schema
    cur = conn.cursor()
    cur.execute(
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema=%s AND table_name='technical_signals'", (schema,))
    assert cur.fetchone()[0] == 0, "fixture unexpectedly created technical_signals"

    import psycopg2
    with pytest.raises(psycopg2.errors.UndefinedTable):
        cur.execute("SELECT 1 FROM technical_signals LIMIT 1")


def test_schema_local_table_still_resolves(pg_schema):
    """Non-vacuity: dropping public must not break the fixture's own tables."""
    conn, schema = pg_schema
    cur = conn.cursor()
    cur.execute("CREATE TABLE probe (x int)")
    cur.execute("INSERT INTO probe VALUES (1)")
    cur.execute("SELECT x FROM probe")
    assert cur.fetchone()[0] == 1


# --- pg_conn: the SECOND search_path, and the one that actually matters -------------------
# pg_conn opens its OWN SQLAlchemy connection, so it carries a search_path independent of
# pg_schema's. Fixing pg_schema on 2026-09-17 did NOT fix this one, and the tests above did
# not notice because they only exercise pg_schema. It is the more dangerous fixture: it is
# what fetcher tests use, and fetchers WRITE. Caught when post_exit_symbols(pg_conn) returned
# live production symbols from a throwaway schema holding no nse_universe_history at all.

def test_pg_conn_search_path_excludes_public(pg_conn):
    row = pg_conn.execute("SHOW search_path").fetchone()
    path = row[0] if not isinstance(row, str) else row
    assert "public" not in path, (
        f"pg_conn search_path={path!r} still contains public -- a fetcher test that forgets a "
        f"CREATE TABLE writes to the PRODUCTION table"
    )


def test_pg_conn_cannot_reach_a_production_only_table(pg_conn):
    """Negative control: with `public` on the path this returns real production rows."""
    try:
        rows = pg_conn.execute("SELECT symbol FROM nse_universe_history LIMIT 1").fetchall()
    except Exception:
        return  # correct: the table does not resolve at all
    assert not rows, f"pg_conn reached production nse_universe_history and got {rows!r}"


def test_pg_conn_schema_local_table_still_works(pg_conn):
    """Non-vacuity: dropping public must not break the fixture's own tables."""
    pg_conn.execute("CREATE TABLE probe2 (x int)")
    pg_conn.execute("INSERT INTO probe2 VALUES (?)", (7,))
    assert pg_conn.execute("SELECT x FROM probe2").fetchone()[0] == 7


def test_no_test_fixture_puts_public_on_the_search_path():
    """Derived from source, so a THIRD fixture cannot reintroduce the class.

    The two tests above name `pg_schema` and `pg_conn`. That is exactly how the second one was
    missed: the guard was asserted per-fixture, and the fixture nobody named kept `public`.
    Scanning the fixture modules instead means a new throwaway-schema fixture fails here rather
    than silently reaching production. Written without a regex on purpose -- plain substring
    checks have no escaping to get wrong.
    """
    root = pathlib.Path(__file__).resolve().parents[1]
    offenders = []
    for name in ("conftest.py", "pg_test_support.py"):
        f = root / name
        if not f.exists():
            continue
        src = f.read_text(encoding="utf-8", errors="replace").splitlines()
        for n, line in enumerate(src, 1):
            low = line.lower()
            if line.lstrip().startswith("#"):
                continue
            if "search_path" not in low or "public" not in low or "set " not in low:
                continue
            # Line-level exemption with a STATED REASON, never a file-level allowlist -- a
            # file-level one would blind this scan to a future real instance in the same file.
            # The marker may sit on the line itself or in the comment block just above it.
            window = "\n".join(src[max(0, n - 9):n])
            if "search-path-public-exempt" in window:
                continue
            offenders.append(f"{name}:{n}: {line.strip()}")
    assert not offenders, (
        "a throwaway-schema fixture put `public` on the search_path -- an unqualified name for "
        "a table the fixture forgot to create resolves to PRODUCTION:\n  "
        + "\n  ".join(offenders))


def test_the_scan_above_is_not_vacuous():
    """The scan must be looking at real fixture files that really do set a search_path."""
    root = pathlib.Path(__file__).resolve().parents[1]
    body = (root / "conftest.py").read_text(encoding="utf-8", errors="replace")
    assert "SET search_path TO" in body, "scan target no longer contains any search_path line"
    assert "search-path-public-exempt" in body, (
        "the DDL-application exemption marker vanished -- either it was removed (good: drop "
        "this assertion) or the scan is now silently exempting nothing it should"
    )
