"""AF-20260827-14: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE even when the
column is already there, and ~50 modules issue it on every run. The db_compat engine skips it when
the column exists and bounds the lock wait when it does not."""
import uuid

import pytest

import db_compat


@pytest.fixture
def probe(pg_db):
    # a new name per test: the session schema is truncated between tests, not rebuilt
    table = f"zz_alter_probe_{uuid.uuid4().hex[:8]}"
    db_compat.execute(f"CREATE TABLE {table} (a REAL)")
    reader = db_compat.connect()
    reader.execute(f"SELECT * FROM {table}")  # holds ACCESS SHARE until the txn ends
    writer = db_compat.connect()
    writer.execute("SET statement_timeout = '3s'")
    try:
        yield table, reader, writer
    finally:
        for c in (writer, reader):
            c.rollback()
            c.close()


def test_present_column_takes_no_lock(probe):
    table, _, writer = probe
    writer.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS a REAL")


def test_missing_column_is_added_under_a_lock_timeout(probe):
    table, reader, writer = probe
    reader.rollback()
    writer.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS b NUMERIC(10,2)")
    assert writer.execute("SHOW lock_timeout").fetchone()[0] == "5s"
    writer.execute(f"SELECT b FROM {table}")


def test_multi_clause_alter_is_left_alone(probe):
    table, reader, writer = probe
    reader.rollback()
    writer.execute(
        f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS a REAL, ADD COLUMN IF NOT EXISTS c REAL"
    )
    writer.execute(f"SELECT c FROM {table}")
