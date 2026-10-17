"""A PM2 cron-boundary restart must not run two overlapping pg_dump processes."""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backup_pg  # noqa: E402


def test_second_backup_cannot_acquire_a_live_backup_lock(tmp_path):
    lock_path = tmp_path / "backup.lock"
    with backup_pg._backup_lock(lock_path, wait_seconds=0) as first:
        assert first is True
        with backup_pg._backup_lock(lock_path, wait_seconds=0) as second:
            assert second is False
    with backup_pg._backup_lock(lock_path, wait_seconds=0) as after_release:
        assert after_release is True


def test_pre_boundary_launch_waits_until_after_cron_restart():
    before = datetime(2026, 10, 17, 23, 14, 59, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    assert backup_pg._pre_cron_delay_seconds(before) >= 60
    after = before + timedelta(seconds=10)
    assert backup_pg._pre_cron_delay_seconds(after) == 0
