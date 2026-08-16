"""Guarantees for the `pg_db` / `pg_db_conn` fixtures (SQLITE_DECOMMISSION_PLAN Phase 2).

These must keep passing before and after every batch of test conversions. They are the only
thing standing between "the Python suite runs on Postgres" and "the Python suite runs on
PRODUCTION Postgres" -- a distinction a 2026-08-15 attempt got wrong, and one that the
TypeScript half got wrong differently on 2026-08-16 (2,148 fabricated rows written to live
stock_ohlcv). Homed as its own file rather than folded into test_sql_translate.py because these
need the fixtures, and the reason that file hoards guards -- suite-timing sensitivity of the
generated_at clock-tick test -- does not apply to a file that adds no timing pressure of its own.
"""
import os
import sys

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)


def test_the_production_schema_is_present(pg_db_conn):
    """A converted test can delete its hand-rolled DDL because the real shape is already here."""
    rows = pg_db_conn.execute(
        "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema()"
    ).fetchall()
    assert rows[0]["n"] >= 200


def test_unqualified_writes_land_in_the_throwaway_schema_not_public(pg_db, pg_db_conn):
    """The whole safety property. An unqualified INSERT must be invisible to `public`."""
    pg_db_conn.execute(
        "INSERT INTO nse_stocks (symbol, name, status) VALUES (?, ?, ?)",
        ("ZZTESTISOLATION", "Isolation Probe", "ACTIVE"),
    )
    pg_db_conn.commit()

    here = pg_db_conn.execute(
        "SELECT count(*) AS n FROM nse_stocks WHERE symbol = ?", ("ZZTESTISOLATION",)
    ).fetchall()
    assert here[0]["n"] == 1

    # `public.nse_stocks` exists on a developer's instance (it IS production) but NOT on CI's
    # empty service container, where a bare `SELECT ... FROM public.nse_stocks` is UndefinedTable
    # rather than a clean 0. Both cases assert the same property -- the write did not land in
    # public -- so resolve the table first instead of assuming it is there. Without this the test
    # is un-runnable in CI, which is where the isolation guarantee most needs proving.
    exists = pg_db_conn.execute(
        "SELECT to_regclass('public.nse_stocks') AS t"
    ).fetchall()[0]["t"]
    if exists is None:
        return  # no production table to contaminate, and the write did not create one
    there = pg_db_conn.execute(
        "SELECT count(*) AS n FROM public.nse_stocks WHERE symbol = ?", ("ZZTESTISOLATION",)
    ).fetchall()
    assert there[0]["n"] == 0, "a test write reached the PRODUCTION table"


def test_current_schema_is_never_public(pg_db_conn):
    rows = pg_db_conn.execute("SELECT current_schema() AS s").fetchall()
    assert rows[0]["s"].startswith("pytest_")


def test_each_test_starts_empty(pg_db_conn):
    """Proves the TRUNCATE half: the row the previous test committed is gone."""
    rows = pg_db_conn.execute(
        "SELECT count(*) AS n FROM nse_stocks WHERE symbol = ?", ("ZZTESTISOLATION",)
    ).fetchall()
    assert rows[0]["n"] == 0


def test_production_code_reaches_the_same_schema_without_being_told(pg_db):
    """db_compat.get_engine() must resolve to the throwaway schema too, not just the fixture's
    own connection -- otherwise a fetcher under test writes to production while the test's
    assertions read a clean sandbox, which is worse than either alone."""
    import db_compat

    with db_compat.get_engine().connect() as c:
        from sqlalchemy import text

        assert c.execute(text("SELECT current_schema()")).scalar().startswith("pytest_")
