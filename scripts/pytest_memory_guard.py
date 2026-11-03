"""Run the complete Python gate without letting it exhaust this host's memory.

The gate kept stopping at 13-25% with "host memory below 1.3 GiB", and it read like a leak in the
suite. Traced 2026-11-01 (AF-20261030-12): pytest's own private bytes stay flat, and the memory is
the WSL VM's Linux FILE CACHE. Test I/O fills it, the VM's own processes used 754 MB of it, and
Windows cannot take it back while the VM stays busy (autoMemoryReclaim only acts when idle).
`drop_caches` moved host available from 1,507 to 4,548 MB with nothing killed. So reclaim first,
and keep the stop threshold exactly where it was.

CUDA is hidden because CI has no GPU, and a CUDA context costs this box ~1.8 GB of host commit
during the DL tests. The tests that need a device skip here: run them on their own with
CUDA_VISIBLE_DEVICES unset (test_dl_engine_alloc_conf.py, test_dl_pinned_host_memory.py).

The stops that looked random across runs were the scheduled jobs sharing this host:
finbert_news_sentiment.py peaks at ~2.5 GB every 15 minutes (confluence_ml_engine.py adds 1.3 GB at
17:00), and stops landed at 16:30:01, 16:46 and 17:00:31 on whichever test was running. So reclaim
early enough to leave room for them, not only when the stop line is already close.

oneDNN is off in the gate process for the same reason: the first CPU backward() costs ~1.3 GB, once,
and flat through later folds, so it is not a leak (measured 2,315 MB vs 1,496 MB without oneDNN).
Production trains on the GPU and never takes this path.

    PGTEST_DB=<dedicated test db> backend-python/venv/Scripts/python.exe scripts/pytest_memory_guard.py
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import time
from pathlib import Path

GIB = 1024 ** 3
START_ABOVE = 2 * GIB
RECLAIM_BELOW = 4 * GIB  # STOP_BELOW + a 2.5 GB finbert run, so the job fits without a stop
STOP_BELOW = 1.3 * GIB
# Free pages take ~10s to reach Windows, and a reclaim right after another finds nothing to drop.
RECLAIM_EVERY_SEC = 30

PRODUCTION_DB = "bharat_intel"
TARGETS = ["src/server/__tests__/", "src/server/tests/", "tests/chatbot/", "scripts/test_backup_pg_capacity.py"]
RECLAIM_COMMAND = ["wsl.exe", "-d", "docker-desktop", "-e", "sh", "-c",
                   "sync; echo 1 > /proc/sys/vm/drop_caches"]


class _MemoryStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                ("total_physical", ctypes.c_ulonglong), ("available_physical", ctypes.c_ulonglong),
                ("total_pagefile", ctypes.c_ulonglong), ("available_pagefile", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong), ("available_virtual", ctypes.c_ulonglong),
                ("available_extended", ctypes.c_ulonglong)]


def available_bytes() -> int:
    state = _MemoryStatus()
    state.length = ctypes.sizeof(state)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(state)):
        raise OSError("Cannot read host memory")
    return state.available_physical


def next_action(available: float, now: float, last_reclaim: float) -> str:
    if available < STOP_BELOW:
        return "stop"
    if available < RECLAIM_BELOW and now - last_reclaim >= RECLAIM_EVERY_SEC:
        return "reclaim"
    return "wait"


def gate_env(environ: dict) -> dict:
    db = environ.get("PGTEST_DB")
    if not db or db == PRODUCTION_DB:
        raise SystemExit(f"Refusing: set PGTEST_DB to a dedicated test database (got {db!r})")
    env = dict(environ)
    env["CUDA_VISIBLE_DEVICES"] = "-1"
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(Path(__file__).resolve().parent), environ.get("PYTHONPATH")]))
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        env.setdefault(var, "2")
    return env


def pytest_configure(config):
    """This module is also the gate's pytest plugin (`-p pytest_memory_guard`)."""
    import torch
    torch.backends.mkldnn.enabled = False


def main() -> int:
    env = gate_env(dict(os.environ))
    if available_bytes() < START_ABOVE:
        raise SystemExit("Not starting: less than 2 GiB available")
    root = Path(__file__).resolve().parents[1]
    targets = [t for t in TARGETS if (root / t).exists()]
    proc = subprocess.Popen([sys.executable, "-m", "pytest", "-q", "-p", "pytest_memory_guard", *targets, *sys.argv[1:]],
                            cwd=root, env=env)
    last_reclaim = -RECLAIM_EVERY_SEC
    reclaims = 0
    while proc.poll() is None:
        time.sleep(3)
        now = time.monotonic()
        action = next_action(available_bytes(), now, last_reclaim)
        if action == "reclaim":
            try:
                subprocess.run(RECLAIM_COMMAND, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=60)
            except subprocess.TimeoutExpired:
                pass                                  # dying here would leave pytest running with nothing watching it
            last_reclaim = now
            reclaims += 1
        elif action == "stop":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            proc.wait(timeout=30)
            raise SystemExit(f"Stopped: host memory below 1.3 GiB after {reclaims} VM cache reclaim(s)")
    print(f"[memory-guard] pytest exit={proc.returncode}, VM cache reclaims={reclaims}", flush=True)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
