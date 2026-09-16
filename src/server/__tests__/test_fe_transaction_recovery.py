"""A swallowed per-symbol exception must not poison the rest of the run.

Live failure: dl-feature-refresh, 2026-08-31.

    sqlalchemy.exc.PendingRollbackError: Can't reconnect until invalid transaction is rolled
    back. Please rollback() fully before proceeding
    [FE] ERROR processing ASKAUTOLTD: Can't reconnect until invalid transaction ...
    [FE] ERROR processing ASIANPAINT: Can't reconnect until invalid transaction ...

The repeated message per symbol is the tell. `feature_engineering.py`'s per-symbol loop
catches every exception and continues to the next symbol -- which is correct intent, and is
exactly what recurring-bugs.md warns about on Postgres: a failed statement aborts the WHOLE
transaction, so every later statement on that connection dies too, each reporting the abort
rather than its own cause. One symbol's genuine error silently became a total run failure.

SQLite tolerates this (a failed statement is local there), which is why the pattern survives
in code that predates the Postgres migration.

The fix is a rollback in the handler. This test proves the recovery actually works against a
REAL Postgres connection -- a mock cannot exhibit transaction-abort semantics at all, so a
mocked test here would pass against the unfixed code and prove nothing.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from feature_engineering import recover_from_failed_statement


def test_a_merely_aborted_connection_is_reported_as_recovered(pg_conn):
    """Rollback succeeded, so the caller keeps the connection.

    NOTE, because the first version of this test asserted the opposite and was wrong: a raw
    aborted transaction is NOT what bit production. `db_compat.ConnWrapper` already rolls back
    before re-raising, and feature_engineering writes through `con.executemany`, i.e. through
    that wrapper. The live 2026-08-31 trace was SQLAlchemy's `_revalidate_connection` raising
    PendingRollbackError -- it was trying to RECONNECT a connection that had died server-side.
    Rollback cannot fix a dead socket; only reopening can. Hence the bool return, and hence the
    dead-connection test below, which is the case that actually mattered."""
    assert recover_from_failed_statement(pg_conn, "SYM", ValueError("boom")) is True


def test_recovery_makes_the_connection_usable_for_the_next_symbol(pg_conn):
    cur = pg_conn.cursor()
    cur.execute("CREATE TABLE fe_probe2 (id int)")
    pg_conn.commit()
    try:
        cur.execute("SELECT * FROM a_table_that_does_not_exist")
    except Exception as exc:
        recover_from_failed_statement(pg_conn, "SOMESYMBOL", exc)

    cur = pg_conn.cursor()
    cur.execute("INSERT INTO fe_probe2 VALUES (1)")
    pg_conn.commit()
    cur.execute("SELECT count(*) FROM fe_probe2")
    assert cur.fetchone()[0] == 1, "the next symbol must be able to write"


def test_recovery_reports_on_stderr_not_stdout(pg_conn, capsys):
    """The message names the symbol whose error actually caused this. It must reach stderr:
    pythonRunner only inspects stderr, so a stdout-only message is invisible to the one hook
    that would surface it (recurring-bugs.md, statically checked elsewhere)."""
    try:
        pg_conn.cursor().execute("SELECT * FROM a_table_that_does_not_exist")
    except Exception as exc:
        recover_from_failed_statement(pg_conn, "ASKAUTOLTD", exc)
    captured = capsys.readouterr()
    assert "ASKAUTOLTD" in captured.err
    assert "ASKAUTOLTD" not in captured.out


def test_recovery_survives_a_connection_that_cannot_be_rolled_back(capsys):
    """If the connection is genuinely dead, rollback() itself raises. That must not become a
    second, more confusing failure on top of the first."""
    class DeadConn:
        def rollback(self):
            raise RuntimeError("server closed the connection unexpectedly")
    assert recover_from_failed_statement(DeadConn(), "SYM", ValueError("original cause")) is False,         "a dead connection must tell the caller to reopen, not claim recovery"
    err = capsys.readouterr().err
    assert "SYM" in err and "reopening" in err
