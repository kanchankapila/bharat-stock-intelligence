"""AF-20261114-01: every database with the timescaledb extension holds one scheduler slot in
max_worker_processes. The data-volume postgresql.conf said 23 and 15 databases exhausted it, so
bharat_intel's own policy jobs could not launch for 11 days. Static check, no database."""
import re
from pathlib import Path

COMPOSE = Path(__file__).resolve().parents[3] / "docker-compose.yml"
# 15 schedulers seen 2026-11-13 + 16 timescaledb.max_background_workers + 4 parallel + 4 logical replication
MIN_WORKERS = 40


def test_compose_pins_max_worker_processes_with_headroom():
    m = re.search(r"-c max_worker_processes=(\d+)", COMPOSE.read_text(encoding="utf-8"))
    assert m, "docker-compose.yml must set max_worker_processes; the volume's postgresql.conf says 23"
    assert int(m.group(1)) >= MIN_WORKERS
