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


# ── `_is_dead_backend` / `_with_dead_backend_retry` (2026-10-01) ────────────────────────────
#
# The live failure these exist for, from `logs/app-2026-10-01.log`:
#   "[QUEUE] screener-performance:live_screener_optimizer failed: ... psycopg2.OperationalError:
#    server closed the connection unexpectedly ... This probably means the server terminated
#    abnormally"
# That killed step 9 of the screener-performance chain on 2026-09-30 (and 08 again on 09-29, on
# two different steps) -- the exact job the digest reports as "failing 50-60% of runs".
#
# `reconnect()` above is the fix for a connection a script HELD across a gap. This is the other
# half and it needed no held connection at all: `read_df`/`execute` borrow from the pool, and a
# backend OOM-killed underneath the pool (AF-20260928-03's host-RAM squeeze is the recurring
# cause) turns the next borrow into an instant, deterministic-looking failure.


def _sqlalchemy_operational_error(sqlstate, message):
    """Build the error shape SQLAlchemy actually raises: the driver error hangs off `.orig`."""
    from sqlalchemy.exc import OperationalError as SAOperationalError

    class _Driver(Exception):
        def __str__(self):
            return message

    orig = _Driver()
    if sqlstate is not None:
        orig.sqlstate = sqlstate
    err = SAOperationalError("SELECT 1", {}, orig)
    if sqlstate is not None:
        err.sqlstate = sqlstate
    return err


@pytest.mark.parametrize("sqlstate", ["57P01", "57P02", "57P03", "08006", "08003", "08001"])
def test_is_dead_backend_recognises_every_documented_sqlstate(sqlstate):
    assert db_compat._is_dead_backend(_sqlalchemy_operational_error(sqlstate, "boom")) is True


def test_is_dead_backend_recognises_the_live_message_without_a_sqlstate():
    """The live 09-30 failure had no SQLSTATE survive the wrap -- only the message did."""
    err = _sqlalchemy_operational_error(None, "server closed the connection unexpectedly")
    assert db_compat._is_dead_backend(err) is True


@pytest.mark.parametrize(
    "message",
    [
        'relation "technical_signals" does not exist',   # a real bug: must surface, never retry
        'syntax error at or near "SELCT"',
        "duplicate key value violates unique constraint",
        "deadlock detected",
    ],
)
def test_is_dead_backend_does_not_swallow_a_real_sql_error(message):
    """Retrying a deterministic SQL error only hides it behind a second identical failure."""
    assert db_compat._is_dead_backend(_sqlalchemy_operational_error(None, message)) is False


def test_retry_recovers_a_transiently_dead_backend(monkeypatch):
    """The regression: one dead backend used to fail the whole step; now the retry succeeds."""
    calls = {"n": 0}

    def _flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _sqlalchemy_operational_error(None, "server closed the connection unexpectedly")
        return "ok"

    monkeypatch.setattr(db_compat, "get_engine", lambda: type("E", (), {"dispose": lambda self: None})())

    assert db_compat._with_dead_backend_retry("test", _flaky) == "ok"
    assert calls["n"] == 2, "the retry must actually re-run the statement"


def test_retry_disposes_the_pool_before_retrying(monkeypatch):
    """pool_pre_ping only validates at CHECKOUT, so the poisoned pool must be dropped."""
    disposed = {"n": 0}
    calls = {"n": 0}

    class _Engine:
        def dispose(self):
            disposed["n"] += 1

    def _flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _sqlalchemy_operational_error(None, "server closed the connection unexpectedly")
        return "ok"

    monkeypatch.setattr(db_compat, "get_engine", lambda: _Engine())
    assert db_compat._with_dead_backend_retry("test", _flaky) == "ok"
    assert disposed["n"] == 1


def test_retry_still_raises_when_the_server_stays_down(monkeypatch):
    """A genuinely-down server must NOT be swallowed into a false success."""
    calls = {"n": 0}

    def _always_dead():
        calls["n"] += 1
        raise _sqlalchemy_operational_error(None, "server closed the connection unexpectedly")

    monkeypatch.setattr(db_compat, "get_engine", lambda: type("E", (), {"dispose": lambda self: None})())

    with pytest.raises(Exception) as exc:
        db_compat._with_dead_backend_retry("test", _always_dead)
    assert "server closed the connection unexpectedly" in str(exc.value)
    assert calls["n"] == 2, "exactly one retry, then surface the real failure"


def test_retry_does_not_retry_a_real_sql_error(monkeypatch):
    calls = {"n": 0}

    def _bad_sql():
        calls["n"] += 1
        raise _sqlalchemy_operational_error(None, 'relation "nope" does not exist')

    monkeypatch.setattr(db_compat, "get_engine", lambda: type("E", (), {"dispose": lambda self: None})())

    with pytest.raises(Exception):
        db_compat._with_dead_backend_retry("test", _bad_sql)
    assert calls["n"] == 1, "a deterministic SQL error must fail on the first attempt"


def test_read_df_routes_through_the_dead_backend_retry(monkeypatch):
    """Behavioural proof read_df is wired to the retry -- NOT a source-text check.

    The first version of this test asserted `"_with_dead_backend_retry" in
    inspect.getsource(db_compat.read_df)`, which was VACUOUS: the helper name also appears in
    read_df's own docstring, so the string was present in the source whether or not the call site
    existed. It reported "20 passed" against a fully reverted file.

    A source-text assertion protects nothing, and neither does faking a SQLAlchemy connection
    (pandas owns the read path, so a fake conn.execute is never reached). What read_df actually
    owns is the DECISION to route through the retry wrapper, so spy on that wrapper: it is a
    behaviour the function must exercise, and reverting the call site makes the spy count zero.
    """
    seen = {"n": 0, "label": ""}
    real = db_compat._with_dead_backend_retry

    def _spy(label, fn, attempts=2):
        seen["n"] += 1
        seen["label"] = label
        return real(label, fn, attempts)

    monkeypatch.setattr(db_compat, "_with_dead_backend_retry", _spy)
    monkeypatch.setattr(db_compat, "get_engine", lambda: type("E", (), {
        "connect": lambda self: type("C", (), {
            "__enter__": lambda s: s, "__exit__": lambda s, *a: False,
            "execute": lambda s, *a, **k: type("R", (), {"fetchall": staticmethod(lambda: [])})(),
        })(), "dispose": lambda s: None})())
    monkeypatch.setattr(db_compat.pd, "read_sql", lambda *a, **k: "df")
    monkeypatch.setattr(db_compat, "translate", lambda s: s)
    monkeypatch.setattr(db_compat, "build_params", lambda p: p)

    assert db_compat.read_df("SELECT 1") == "df"
    assert seen["n"] == 1, "read_df must route its pooled read through the dead-backend retry"
    assert "read_df" in seen["label"], "the retry must name the statement it is guarding"


def test_execute_routes_through_the_dead_backend_retry(monkeypatch):
    """Same contract for the write path, which is the one that must stay non-duplicating."""
    seen = {"n": 0}
    real = db_compat._with_dead_backend_retry

    def _spy(label, fn, attempts=2):
        seen["n"] += 1
        return real(label, fn, attempts)

    monkeypatch.setattr(db_compat, "_with_dead_backend_retry", _spy)
    monkeypatch.setattr(db_compat, "get_engine", lambda: type("E", (), {
        "begin": lambda self: type("B", (), {
            "__enter__": lambda s: s, "__exit__": lambda s, *a: False,
            "execute": lambda s, *a, **k: type("R", (), {"rowcount": 1})(),
        })(), "dispose": lambda s: None})())
    monkeypatch.setattr(db_compat, "translate", lambda s: s)
    monkeypatch.setattr(db_compat, "build_params", lambda p: p)

    db_compat.execute("UPDATE t SET x=1 WHERE k=?", ("K",))
    assert seen["n"] == 1, "execute must route its pooled write through the dead-backend retry"


def test_read_df_does_not_hide_a_real_sql_error(monkeypatch):
    """The other half: a genuine SQL error must surface, not be retried into a fake success.

    `pd.read_sql` is what actually issues the statement here, so the error must be raised FROM it
    -- an earlier draft mocked it out, which made the test pass for the wrong reason (the mock
    swallowed the error instead of raising it). The assertion that matters is on the retry: a
    deterministic SQL error must not be attempted twice, and must reach the caller unchanged.
    """
    calls = {"n": 0}
    real = db_compat._with_dead_backend_retry

    def _spy(label, fn, attempts=2):
        calls["n"] += 1
        return real(label, fn, attempts)

    def _raise_real_sql_error(*a, **k):
        raise _sqlalchemy_operational_error(None, 'relation "nope" does not exist')

    monkeypatch.setattr(db_compat, "_with_dead_backend_retry", _spy)
    monkeypatch.setattr(db_compat, "get_engine", lambda: type("E", (), {
        "connect": lambda self: type("C", (), {
            "__enter__": lambda s: s, "__exit__": lambda s, *a: False,
            "execute": lambda s, *a, **k: None,
        })(), "dispose": lambda s: None})())
    monkeypatch.setattr(db_compat.pd, "read_sql", _raise_real_sql_error)
    monkeypatch.setattr(db_compat, "translate", lambda s: s)
    monkeypatch.setattr(db_compat, "build_params", lambda p: p)

    with pytest.raises(Exception) as exc:
        db_compat.read_df("SELECT 1")
    assert "nope" in str(exc.value), "the real SQL error must reach the caller unchanged"
    assert calls["n"] == 1, "a deterministic SQL error must be attempted exactly once"


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
