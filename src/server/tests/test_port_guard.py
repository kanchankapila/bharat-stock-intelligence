"""port_guard.wait_for_port_free -- AF-20260930-42.

2026-09-30 11:50-11:53 IST: on a pm2 restart the OLD chatbot/engine-worker interpreter still held
127.0.0.1:8001/8005 (pm2 on Windows tracks the venv redirector PID, not the real interpreter), so
each new instance died on `[Errno 10048]` and pm2 restarted it ~120 times in 3 minutes.
"""
import os
import socket
import sys
import threading
import time

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
    assert {"python_api.py", "worker_service.py", "app.py", "main.py"} <= set(services), services


def test_gives_up_with_a_clear_exit_instead_of_crash_looping():
    s, port = _listen()
    try:
        with pytest.raises(SystemExit) as exc:
            port_guard.wait_for_port_free("127.0.0.1", port, timeout_s=0.5, interval_s=0.1)
        assert str(port) in str(exc.value.code)
    finally:
        s.close()
