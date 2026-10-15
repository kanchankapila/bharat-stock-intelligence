"""Safely release a stale managed-service port before binding it.

pm2 on Windows tracks the venv redirector PID, not the real interpreter, so on a restart the
previous interpreter can still hold its port for minutes. uvicorn then fails with
`[Errno 10048]` and exits 1, pm2 restarts it at once, and the loop repeats: chatbot and
engine-worker restarted ~120 times between 11:50 and 11:53 IST on 2026-09-30. Waiting here
turns that into one slow start, and a real conflict into one clear exit instead of a loop.

On 2026-10-14 the PM2 daemon itself disappeared while its child interpreters survived. Merely
waiting could never recover that state: every replacement timed out after five minutes, which
PM2 counted as a stable run because ``min_uptime`` was only ten seconds. A service may now
terminate the exact stale PID only when the local health response proves that the listener has
the same expected service identity. Unknown or malformed listeners are never killed.
"""
import json
import os
import signal
import socket
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def _port_free(host: str, port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Exclusive on Windows so an existing listener is detected, not shared.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _managed_owner(host: str, port: int) -> tuple[str, int] | None:
    """Return the local listener's declared service and PID, if its health body is trustworthy."""
    probe_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    try:
        response = urlopen(f"http://{probe_host}:{port}/health", timeout=2)  # noqa: S310
    except HTTPError as exc:
        # Readiness endpoints legitimately use 503 (for example chatbot without an LLM key),
        # but the JSON identity is still valid evidence of which local process owns the port.
        response = exc
    except (OSError, URLError):
        return None

    try:
        payload = json.loads(response.read().decode("utf-8"))
        service = payload.get("service")
        pid = payload.get("pid")
        if isinstance(service, str) and isinstance(pid, int) and pid > 0:
            return service, pid
    except (AttributeError, json.JSONDecodeError, UnicodeDecodeError):
        pass
    finally:
        response.close()
    return None


def _terminate_process(pid: int) -> None:
    """Terminate one verified stale interpreter (SIGTERM maps to TerminateProcess on Windows)."""
    os.kill(pid, signal.SIGTERM)


# 300s: the measured hold on 2026-09-30 was ~170s (11:50:01 -> 11:52:53); the budget must exceed
# the longest observed hold or the guard only turns one crash loop into two slower ones.
def wait_for_port_free(
    host: str,
    port: int,
    timeout_s: float = 300,
    interval_s: float = 1.0,
    *,
    expected_service: str | None = None,
) -> None:
    if not _port_free(host, port) and expected_service:
        owner = _managed_owner(host, port)
        if owner and owner[0] == expected_service and owner[1] != os.getpid():
            try:
                _terminate_process(owner[1])
                print(
                    f"[port_guard] terminated stale {expected_service} pid {owner[1]} "
                    f"holding {host}:{port}",
                    file=sys.stderr,
                    flush=True,
                )
            except (OSError, ProcessLookupError) as exc:
                print(
                    f"[port_guard] could not terminate stale {expected_service} pid {owner[1]}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )

    deadline = time.monotonic() + timeout_s
    announced = False
    while not _port_free(host, port):
        if time.monotonic() >= deadline:
            raise SystemExit(
                f"[port_guard] {host}:{port} still in use after {timeout_s:.0f}s -- another process "
                f"owns it; find it with: Get-NetTCPConnection -LocalPort {port} -State Listen"
            )
        if not announced:
            print(f"[port_guard] {host}:{port} busy (previous instance still exiting?) -- waiting "
                  f"up to {timeout_s:.0f}s", file=sys.stderr, flush=True)
            announced = True
        time.sleep(interval_s)
