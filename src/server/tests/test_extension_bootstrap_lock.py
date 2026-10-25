"""Extension DDL is database-global even when the test tables are schema-private."""
import pytest
from pg_test_support import _pg_dsn, ensure_test_extensions, pg_available

LOCK = "SELECT pg_advisory_lock(hashtext('bsi_test_extensions'), 0)"
UNLOCK = "SELECT pg_advisory_unlock(hashtext('bsi_test_extensions'), 0)"
DDL = 'CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE EXTENSION IF NOT EXISTS pg_stat_statements;'


class RecordingCursor:
    def __init__(self, fail_create=False, existing_home=None):
        self.calls = []
        self.fail_create = fail_create
        self.existing_home = existing_home

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if self.fail_create and sql.startswith('CREATE EXTENSION'):
            raise RuntimeError('extension installation failed')

    def fetchone(self):
        return (self.existing_home,) if self.existing_home else None


def test_schema_bootstrap_serializes_global_extension_creation():
    cur = RecordingCursor()
    assert ensure_test_extensions(cur, DDL) == {'public'}
    statements = [sql for sql, _ in cur.calls]
    assert LOCK in statements
    assert UNLOCK in statements
    creates = [i for i, sql in enumerate(statements) if sql.startswith('CREATE EXTENSION')]
    assert creates
    assert statements.index(LOCK) < min(creates) < max(creates) < statements.index(UNLOCK)
    assert all('WITH SCHEMA public' in statements[i] for i in creates)


def test_schema_bootstrap_releases_lock_without_hiding_create_failure():
    cur = RecordingCursor(fail_create=True)
    with pytest.raises(RuntimeError, match='extension installation failed'):
        ensure_test_extensions(cur, DDL)
    assert cur.calls[-1][0] == UNLOCK


def test_existing_extension_homes_are_preserved_without_relocating_them():
    cur = RecordingCursor(existing_home='shared_extensions')
    assert ensure_test_extensions(cur, DDL) == {'shared_extensions'}
    assert not any(sql.startswith('CREATE EXTENSION') for sql, _ in cur.calls)
    assert cur.calls[-1][0] == UNLOCK


@pytest.mark.postgres
def test_real_bootstrap_waits_for_another_initializer_instead_of_racing():
    import time
    from concurrent.futures import ThreadPoolExecutor
    import psycopg2

    if not pg_available():
        pytest.skip('Postgres required for extension lock integration check')
    owner = psycopg2.connect(**_pg_dsn())
    waiter = psycopg2.connect(**_pg_dsn())
    owner.autocommit = waiter.autocommit = True
    try:
        with owner.cursor() as holder, ThreadPoolExecutor(max_workers=1) as pool:
            holder.execute(LOCK)
            def bootstrap():
                with waiter.cursor() as cur:
                    return ensure_test_extensions(cur, DDL)
            future = pool.submit(bootstrap)
            try:
                deadline = time.monotonic() + 15
                blocked = False
                while time.monotonic() < deadline and not future.done():
                    holder.execute('SELECT %s = ANY(pg_blocking_pids(%s))',
                                   (owner.get_backend_pid(), waiter.get_backend_pid()))
                    if holder.fetchone()[0]:
                        blocked = True
                        break
                    time.sleep(0.01)
                assert blocked, 'bootstrap bypassed the shared extension lock'
            finally:
                holder.execute(UNLOCK)
            assert future.result(timeout=15) == {'public'}
    finally:
        waiter.close()
        owner.close()
