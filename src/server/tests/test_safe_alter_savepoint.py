"""safe_alter on the caller's own connection must not poison the caller's transaction -- AF-20260930-48.

Since 2026-09-17 safe_alter runs on the connection the caller passes. When the ALTER fails for any
reason other than "column already exists" (the table is missing), Postgres aborts that open
transaction; the caller's next commit() then rolls back everything uncommitted -- including the
CREATE TABLE it had just issued. Seen as test_live_datasource_nse_deals_rollover failing with
`relation "fno_rollover" does not exist` right after ensure_schema() "created" it. Five production
callers do CREATE TABLE then ALTER in one transaction (event_triggers, fno_rollover_fetcher,
high_flyer_retrospective x3, ml_calibration).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402

from db_compat import safe_alter  # noqa: E402


def _count(con, table):
    return con.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]


def test_a_failed_alter_does_not_roll_back_the_callers_create_table():
    con = pg_memory_conn()
    con.execute("CREATE TABLE sa_made (a INTEGER)")          # uncommitted, same transaction
    assert safe_alter(con, "ALTER TABLE sa_no_such_table ADD COLUMN x INTEGER") is False
    con.execute("INSERT INTO sa_made VALUES (1)")            # raises InFailedSqlTransaction if poisoned
    con.commit()
    assert _count(con, "sa_made") == 1


def test_a_successful_alter_still_adds_the_column():
    con = pg_memory_conn()
    con.execute("CREATE TABLE sa_cols (a INTEGER)")
    assert safe_alter(con, "ALTER TABLE sa_cols ADD COLUMN b INTEGER") is True
    con.execute("INSERT INTO sa_cols (a, b) VALUES (1, 2)")
    con.commit()
    assert _count(con, "sa_cols") == 1


def test_alter_for_an_existing_column_is_a_quiet_success():
    con = pg_memory_conn()
    con.execute("CREATE TABLE sa_dup (a INTEGER, b INTEGER)")
    assert safe_alter(con, "ALTER TABLE sa_dup ADD COLUMN b INTEGER") is True
    con.commit()
