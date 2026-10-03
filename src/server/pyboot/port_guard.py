"""Wait for a service port to be released before binding it (AF-20260930-42).

pm2 on Windows tracks the venv redirector PID, not the real interpreter, so on a restart the
previous interpreter can still hold its port for minutes. uvicorn then fails with
`[Errno 10048]` and exits 1, pm2 restarts it at once, and the loop repeats: chatbot and
engine-worker restarted ~120 times between 11:50 and 11:53 IST on 2026-09-30. Waiting here
turns that into one slow start, and a real conflict into one clear exit instead of a loop.
"""
import socket
import sys
import time


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


# 300s: the measured hold on 2026-09-30 was ~170s (11:50:01 -> 11:52:53); the budget must exceed
# the longest observed hold or the guard only turns one crash loop into two slower ones.
def wait_for_port_free(host: str, port: int, timeout_s: float = 300, interval_s: float = 1.0) -> None:
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
