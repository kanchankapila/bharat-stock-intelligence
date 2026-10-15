"""port_guard.wait_for_port_free -- AF-20260930-42.

2026-09-30 11:50-11:53 IST: on a pm2 restart the OLD chatbot/engine-worker interpreter still held
127.0.0.1:8001/8005 (pm2 on Windows tracks the venv redirector PID, not the real interpreter), so
each new instance died on `[Errno 10048]` and pm2 restarted it ~120 times in 3 minutes.
"""
import os
import re
import socket
import sys
import threading
import time
from io import BytesIO

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pyboot"))

import port_guard


def _listen():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    return s, s.getsockname()[1]


def test_returns_immediately_when_port_is_free():
    s, port = _listen()
    s.close()
    t0 = time.monotonic()
    port_guard.wait_for_port_free("127.0.0.1", port, timeout_s=5, interval_s=0.1)
    assert time.monotonic() - t0 < 1


def test_waits_until_the_previous_holder_releases_the_port():
    s, port = _listen()
    threading.Timer(0.8, s.close).start()
    t0 = time.monotonic()
    port_guard.wait_for_port_free("127.0.0.1", port, timeout_s=10, interval_s=0.1)
    assert 0.5 < time.monotonic() - t0 < 5


def test_every_service_entrypoint_waits_for_its_port_before_binding():
    """Derived from the source tree, not a list: any file that calls uvicorn.run( must call
    wait_for_port_free( first, so a new service cannot reintroduce the restart loop."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[3]
    candidates = [*(root / "src" / "server").rglob("*.py"), *(root / "backend-python").glob("*.py")]
    services = []
    for f in candidates:
        if "tests" in f.parts or "__pycache__" in f.parts or "venv" in f.parts:
            continue
        text = f.read_text(encoding="utf-8", errors="ignore")
        if "uvicorn.run(" not in text:
            continue
        services.append(f.name)
        run_at = text.index("uvicorn.run(")
        guard_at = text.find("wait_for_port_free(")
        assert 0 <= guard_at < run_at, f"{f}: uvicorn.run( without a preceding wait_for_port_free("
        assert "expected_service=" in text[guard_at:run_at], (
            f"{f}: port guard cannot distinguish its own stale interpreter from an unrelated listener"
        )
        expected = re.search(r'expected_service="([^"]+)"', text[guard_at:run_at])
        assert expected, f"{f}: expected service identity must be a static, reviewable value"
        assert f'"service": "{expected.group(1)}"' in text, (
            f"{f}: health response does not expose the identity used by port_guard"
        )
        assert '"pid": os.getpid()' in text, (
            f"{f}: health response does not expose the exact process port_guard may terminate"
        )
    assert {"python_api.py", "worker_service.py", "app.py", "main.py"} <= set(services), services


def test_gives_up_with_a_clear_exit_instead_of_crash_looping():
    s, port = _listen()
    try:
        with pytest.raises(SystemExit) as exc:
            port_guard.wait_for_port_free("127.0.0.1", port, timeout_s=0.5, interval_s=0.1)
        assert str(port) in str(exc.value.code)
    finally:
        s.close()


class _Response:
    def __init__(self, payload: bytes):
        self._body = BytesIO(payload)

    def read(self):
        return self._body.read()

    def close(self):
        pass


def test_matching_managed_owner_is_terminated_once(monkeypatch):
    free = iter([False, False, True])
    terminated = []
    monkeypatch.setattr(port_guard, "_port_free", lambda *_: next(free))
    monkeypatch.setattr(port_guard, "_managed_owner", lambda *_: ("ml-api", 4242))
    monkeypatch.setattr(port_guard, "_terminate_process", terminated.append)

    port_guard.wait_for_port_free(
        "127.0.0.1", 8000, timeout_s=1, interval_s=0, expected_service="ml-api"
    )

    assert terminated == [4242]


def test_different_service_identity_is_never_terminated(monkeypatch):
    terminated = []
    monkeypatch.setattr(port_guard, "_port_free", lambda *_: False)
    monkeypatch.setattr(port_guard, "_managed_owner", lambda *_: ("unrelated-service", 4242))
    monkeypatch.setattr(port_guard, "_terminate_process", terminated.append)

    with pytest.raises(SystemExit):
        port_guard.wait_for_port_free(
            "127.0.0.1", 8000, timeout_s=0, interval_s=0, expected_service="ml-api"
        )

    assert terminated == []


def test_health_probe_accepts_degraded_json_identity(monkeypatch):
    body = BytesIO(b'{"status":"degraded","service":"chatbot","pid":1234}')
    degraded = port_guard.HTTPError("http://127.0.0.1:8001/health", 503, "degraded", {}, body)

    def raise_degraded(*_args, **_kwargs):
        raise degraded

    monkeypatch.setattr(port_guard, "urlopen", raise_degraded)

    assert port_guard._managed_owner("127.0.0.1", 8001) == ("chatbot", 1234)


@pytest.mark.parametrize(
    "payload",
    [
        b'{"service":"ml-api"}',
        b'{"service":"ml-api","pid":"1234"}',
        b'{"service":"ml-api","pid":0}',
        b"not-json",
    ],
)
def test_health_probe_rejects_unusable_identity(monkeypatch, payload):
    monkeypatch.setattr(port_guard, "urlopen", lambda *_args, **_kwargs: _Response(payload))

    assert port_guard._managed_owner("127.0.0.1", 8000) is None


def test_pm2_stability_window_exceeds_port_guard_timeout():
    """A guard timeout must count toward max_restarts, not reset it forever as a stable run."""
    from pathlib import Path

    ecosystem = (Path(__file__).resolve().parents[3] / "ecosystem.config.cjs").read_text("utf-8")
    value = re.search(r"min_uptime:\s*([\d_]+)", ecosystem)
    assert value
    assert int(value.group(1).replace("_", "")) > 300_000
