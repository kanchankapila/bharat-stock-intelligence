import datetime as dt

from bharat_alpha.pipeline import scheduler
from bharat_alpha.timeutil import IST


class _ConnectionContext:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, *_args):
        return False


def test_preopen_tick_cannot_start_the_heavy_daily_dag(monkeypatch):
    conn = object()
    calls = []
    now = dt.datetime(2026, 10, 6, 9, 10, tzinfo=IST)
    monkeypatch.setattr(scheduler, "connect", lambda: _ConnectionContext(conn))
    monkeypatch.setattr(scheduler, "capture_preopen", lambda got_conn, got_now: calls.append((got_conn, got_now)) or {"rows": 42})
    monkeypatch.setattr(scheduler, "pending_sessions", lambda *_args: (_ for _ in ()).throw(AssertionError("heavy daily DAG reached")))

    assert scheduler.preopen_tick(now) == {"rows": 42}
    assert calls == [(conn, now)]
