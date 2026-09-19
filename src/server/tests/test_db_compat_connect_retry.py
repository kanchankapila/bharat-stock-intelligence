"""`db_compat.connect()` — retrying a transient connection-timeout on the FIRST connect.

Why this exists (AF-20260919-01 / AF-20260917-24). ~15+ Python steps in ml-daily-ops connect
to the same Postgres within a short evening window; a momentary server-side max_connections
saturation from a concurrently-running sibling job can fail an unlucky script's very first
`connect()` with no chance to recover. Measured live: `mc_chart_patterns_fetcher.py` runs in
3.9s against a 120s budget (30x headroom) yet still failed outright on 2026-09-15 and
2026-09-18 -- nothing wrong in the script, a transient connection blip at the moment it ran.

The trap a naive retry could introduce: masking a REAL, persistently-down server as if it were
healthy. `connect()` must retry only `OperationalError`/`TimeoutError` (the transient class),
a bounded number of times, and still raise the real exception once retries are exhausted.
"""
import os
import sys

import pytest
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as SATimeoutError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import db_compat


class _FakeEngine:
    """Raises on connect() a fixed number of times, then succeeds."""

    def __init__(self, fail_times, exc_cls=OperationalError):
        self.fail_times = fail_times
        self.exc_cls = exc_cls
        self.calls = 0

    def connect(self):
        self.calls += 1
        if self.calls <= self.fail_times:
            if self.exc_cls is OperationalError:
                raise OperationalError("fake", {}, Exception("timeout exceeded when trying to connect"))
            raise SATimeoutError("QueuePool limit reached, connection timed out")
        return "REAL_CONNECTION"


def test_connect_retries_transient_failure_then_succeeds(monkeypatch):
    """The regression: a momentary pool/server timeout must not fail the caller's first attempt."""
    fake = _FakeEngine(fail_times=2)
    monkeypatch.setattr(db_compat, "get_engine", lambda: fake)
    monkeypatch.setattr(db_compat, "ConnWrapper", lambda c: c)  # identity wrap for the test
    monkeypatch.setattr(db_compat.time, "sleep", lambda *_: None)  # no real waiting in tests

    got = db_compat.connect()

    assert got == "REAL_CONNECTION"
    assert fake.calls == 3, "expected 2 failures + 1 success = 3 total connect() calls"


def test_connect_retries_sqlalchemy_timeout_error_too(monkeypatch):
    """Negative control on the exception TYPE: SATimeoutError is the other transient class."""
    fake = _FakeEngine(fail_times=1, exc_cls=SATimeoutError)
    monkeypatch.setattr(db_compat, "get_engine", lambda: fake)
    monkeypatch.setattr(db_compat, "ConnWrapper", lambda c: c)
    monkeypatch.setattr(db_compat.time, "sleep", lambda *_: None)

    got = db_compat.connect()

    assert got == "REAL_CONNECTION"
    assert fake.calls == 2


def test_connect_raises_after_exhausting_retries_on_persistent_failure(monkeypatch):
    """A REAL outage must not be silently swallowed -- the whole point of bounding the retry."""
    fake = _FakeEngine(fail_times=99)  # never succeeds
    monkeypatch.setattr(db_compat, "get_engine", lambda: fake)
    monkeypatch.setattr(db_compat, "ConnWrapper", lambda c: c)
    monkeypatch.setattr(db_compat.time, "sleep", lambda *_: None)

    with pytest.raises(OperationalError):
        db_compat.connect()

    assert fake.calls == 3, "must attempt exactly 3 times, not retry forever"


def test_connect_does_not_retry_on_an_unrelated_exception(monkeypatch):
    """Negative control: a non-transient error (e.g. a real programming bug) must propagate
    immediately on the FIRST attempt -- retrying it would just delay a real failure."""
    class _Boom:
        def connect(self):
            raise ValueError("not a connection-timeout class of error")

    monkeypatch.setattr(db_compat, "get_engine", lambda: _Boom())
    monkeypatch.setattr(db_compat, "ConnWrapper", lambda c: c)

    with pytest.raises(ValueError):
        db_compat.connect()
