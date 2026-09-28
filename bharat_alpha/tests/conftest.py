"""Tests run against a real, EMPTY Postgres database created per session.

Not a schema on a shared database: a table a fixture forgot must fail loudly rather than
resolve to production's copy (legacy: three suites were green on a developer box because
`public` on the search_path silently supplied the missing table).

Set BQA_TEST_ADMIN_DSN to a server where the test user may CREATE DATABASE
(default: postgresql://postgres@/postgres?host=/tmp&port=55432).
"""
from __future__ import annotations

import os
import uuid

import psycopg
import pytest

# Pure unit tests read thresholds from Settings, which requires a DSN. This one points nowhere,
# so any test that touches the DB without the `conn` fixture fails loudly instead of finding one.
os.environ.setdefault("BQA_DATABASE_URL", "postgresql://no-db-for-unit-tests.invalid/none")

ADMIN_DSN = os.environ.get("BQA_TEST_ADMIN_DSN", "postgresql://postgres@/postgres?host=/tmp&port=55432")


def _dsn_for(dbname: str) -> str:
    base, _, query = ADMIN_DSN.partition("?")
    base = base.rsplit("/", 1)[0] + "/" + dbname
    return base + ("?" + query if query else "")


@pytest.fixture(scope="session")
def db_dsn():
    name = f"bqa_test_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    dsn = _dsn_for(name)
    os.environ["BQA_DATABASE_URL"] = dsn
    from bharat_alpha.config import get_settings

    get_settings.cache_clear()
    yield dsn
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture()
def conn(db_dsn):
    """A freshly-migrated, empty `alpha` schema for each test."""
    from bharat_alpha.db.migrate import migrate

    c = psycopg.connect(db_dsn)
    with c.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS alpha CASCADE")
    c.commit()
    migrate(c)
    yield c
    c.rollback()
    c.close()


@pytest.fixture()
def artifacts(tmp_path, monkeypatch):
    monkeypatch.setenv("BQA_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    from bharat_alpha.config import get_settings

    get_settings.cache_clear()
    yield tmp_path / "artifacts"
    get_settings.cache_clear()


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_LIVE_DATASOURCE_TESTS") == "1":
        return
    skip = pytest.mark.skip(reason="live datasource test; set RUN_LIVE_DATASOURCE_TESTS=1")
    for item in items:
        if "live_datasource" in item.keywords:
            item.add_marker(skip)
