"""AF-20261114-01: every database with the timescaledb extension holds one scheduler slot in
timescaledb.max_background_workers AND in max_worker_processes. The data-volume postgresql.conf
said 16 and 23; 15 databases filled the TimescaleDB pool with schedulers, so bharat_intel's own
policy jobs could not launch for 11 days. Raising max_worker_processes alone did not fix it.
Static check, no database."""
import re
from pathlib import Path

COMPOSE = Path(__file__).resolve().parents[3] / "docker-compose.yml"
SCHEDULERS = 15        # databases with the extension, 2026-11-13
JOBS = 8               # bharat_intel's policy jobs that can be due at once
NON_TIMESCALE = 1 + 4 + 4   # launcher + max_parallel_workers + logical replication workers


def _setting(name):
    m = re.search(rf"-c {re.escape(name)}=(\d+)", COMPOSE.read_text(encoding="utf-8"))
    assert m, f"docker-compose.yml must set {name}; the volume's postgresql.conf is too small"
    return int(m.group(1))


def test_timescaledb_pool_fits_every_scheduler_plus_the_jobs():
    assert _setting("timescaledb.max_background_workers") >= SCHEDULERS + JOBS


def test_max_worker_processes_fits_the_timescaledb_pool_and_the_rest():
    assert _setting("max_worker_processes") >= _setting("timescaledb.max_background_workers") + NON_TIMESCALE
