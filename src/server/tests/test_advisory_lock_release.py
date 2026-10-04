"""AF-20261004-01: try_advisory_lock() parks a connection for the whole run; a run longer than the
server/relay idle timeout finds that connection dead. A session-level advisory lock dies with its
session, so a failed unlock means "already released" -- it must not turn a finished run into a
crash (live_screener_resolver drained 200k rows, then raised from its `finally` on 2026-10-04)."""
import os
import sys

import pytest
from sqlalchemy.exc import OperationalError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import db_compat  # noqa: E402


class _DeadConn:
    closed = False

    def execute(self, *a, **k):
        raise OperationalError("SELECT pg_advisory_unlock(1)", {}, Exception("server closed the connection unexpectedly"))

    def commit(self):
        raise AssertionError("commit must not be reached after a failed unlock")

    def close(self):
        self.closed = True


def test_release_on_a_dead_connection_does_not_raise(monkeypatch):
    dead = _DeadConn()
    monkeypatch.setitem(db_compat._advisory_conns, "unit-test-lock", dead)

    db_compat.release_advisory_lock("unit-test-lock")      # must not raise

    assert dead.closed
    assert "unit-test-lock" not in db_compat._advisory_conns


def test_release_of_an_unknown_lock_is_still_a_no_op():
    db_compat.release_advisory_lock("never-taken")


def test_a_non_connection_error_is_not_swallowed(monkeypatch):
    class _Boom(_DeadConn):
        def execute(self, *a, **k):
            raise ValueError("programming error")

    monkeypatch.setitem(db_compat._advisory_conns, "unit-test-lock2", _Boom())
    with pytest.raises(ValueError):
        db_compat.release_advisory_lock("unit-test-lock2")
