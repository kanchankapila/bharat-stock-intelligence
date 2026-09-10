"""`db_compat.reconnect()` — discarding a connection that may already be dead.

Why this helper exists. A connection checked out at the top of a long function and left idle
while a SEPARATE connection does 10+ minutes of real work gets closed server-side, and
`pool_pre_ping` cannot catch it (pre_ping validates at pool CHECKOUT, not while checked out).
The documented repair is "reconnect right before the gap's first post-loop use".

The trap this file guards: **the repair has the same failure mode as the thing it repairs.**
`ConnWrapper.close()` delegates to SQLAlchemy's `Connection.close()`, which issues a ROLLBACK on
the underlying DBAPI connection before returning it to the pool -- and on a dead socket that
rollback raises the very `OperationalError: server closed the connection unexpectedly` the
reconnect was written to work around. Live-observed twice:

  - strategy_optimizer.py  2026-08-29 -- crashed after a full grid search + 888 overrides
  - backtest_optimizer.py  2026-09-10 -- crashed at the first post-loop statement, which IS
    the reconnect; stdout ended on the grid loop's own print, stderr was `do_rollback`

strategy_optimizer.py was fixed in place on 2026-08-29; backtest_optimizer.py, fixed for the
ORIGINAL bug two days EARLIER, never received the follow-up. One class, two files, one fixed --
which is exactly why the guard belongs in the shared helper rather than in each caller.

We are discarding the connection either way, so a failing `close()` is not a reason to abort.
Failing to open the NEW connection is.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import db_compat


class _DeadConn:
    """close() raises the way SQLAlchemy does when the server already dropped the socket."""

    def __init__(self):
        self.close_calls = 0

    def close(self):
        self.close_calls += 1
        raise Exception("server closed the connection unexpectedly")


class _LiveConn:
    def __init__(self):
        self.close_calls = 0

    def close(self):
        self.close_calls += 1


def test_reconnect_returns_a_new_connection_when_close_raises(monkeypatch):
    """The regression: a dead connection must not make the reconnect itself explode."""
    sentinel = object()
    monkeypatch.setattr(db_compat, "connect", lambda *a, **k: sentinel)

    dead = _DeadConn()
    got = db_compat.reconnect(dead)

    assert dead.close_calls == 1, "reconnect must still attempt to close the old connection"
    assert got is sentinel, "reconnect must return the freshly opened connection"


def test_reconnect_closes_and_replaces_a_healthy_connection(monkeypatch):
    """Negative control: the happy path must still close the old handle, not leak it."""
    sentinel = object()
    monkeypatch.setattr(db_compat, "connect", lambda *a, **k: sentinel)

    live = _LiveConn()
    got = db_compat.reconnect(live)

    assert live.close_calls == 1
    assert got is sentinel


def test_reconnect_propagates_a_failure_to_OPEN_the_new_connection(monkeypatch):
    """A failed close() is survivable; a failed connect() is not -- it must NOT be swallowed.

    Swallowing this would hand the caller a dead or None handle and move the crash somewhere
    less diagnosable, which is the whole failure pattern this helper exists to end.
    """
    def _boom(*a, **k):
        raise Exception("could not connect to server")

    monkeypatch.setattr(db_compat, "connect", _boom)

    with pytest.raises(Exception, match="could not connect to server"):
        db_compat.reconnect(_DeadConn())


def test_reconnect_reports_the_swallowed_close_failure_to_stderr(monkeypatch, capsys):
    """A swallowed failure that prints nothing is indistinguishable from no failure.

    recurring-bugs.md: a degraded-read message printed to stdout defeats the subprocess wrapper,
    which only inspects stderr -- so this notice must go to stderr specifically.
    """
    monkeypatch.setattr(db_compat, "connect", lambda *a, **k: object())
    db_compat.reconnect(_DeadConn())

    captured = capsys.readouterr()
    assert "server closed the connection unexpectedly" in captured.err, (
        "the swallowed close() failure must be reported on stderr"
    )
    assert captured.out == "", "the notice must not go to stdout (subprocess wrappers ignore it)"
