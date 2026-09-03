"""Tests for backup_pg.py's _is_within_schedule_window() -- the Python twin of
market-calendar's isWithinScheduleWindow (greenfield/packages/market-calendar/src/
session-calendar.ts). Mirrors that file's own test cases (index.test.ts) so a
transcription slip in the Python port -- the offset arithmetic, the midnight
wraparound, the tolerance value -- doesn't go unnoticed the way it would with zero
coverage on this side. See backup_pg.py's own docstring for the live 2026-09-03
incident this guard fixes: a pm2 restart at 09:20 IST fired a full pg_dump mid-morning
during market hours, blocking a concurrent schema migration for ~12 minutes.
"""
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backup_pg  # noqa: E402


class _FixedDatetime(datetime):
    """Stand-in for backup_pg's `datetime.now(timezone.utc)` call -- subclassing
    (rather than a plain Mock) keeps every other datetime construction inside
    _is_within_schedule_window (the `.replace(...)` call) working unmodified."""
    _fixed: "datetime"

    @classmethod
    def now(cls, tz=None):
        return cls._fixed


def _check(utc_iso: str) -> bool:
    _FixedDatetime._fixed = datetime.fromisoformat(utc_iso).replace(tzinfo=timezone.utc)
    with patch("backup_pg.datetime", _FixedDatetime):
        return backup_pg._is_within_schedule_window()


class TestBackupScheduleGuard:
    def test_rejects_the_live_incident_timestamp(self):
        # 2026-09-03T03:50:00Z = 09:20 IST -- the actual spurious pm2-registration launch.
        assert _check("2026-09-03T03:50:00") is False

    def test_accepts_the_real_cron_fire_at_23_15_ist(self):
        # 2026-09-02T17:45:00Z = 23:15 IST.
        assert _check("2026-09-02T17:45:00") is True

    def test_rejects_a_fire_outside_the_5_minute_tolerance(self):
        # 2026-09-02T17:00:00Z = 22:30 IST -- 45 min before target, well outside the
        # tight tolerance (this job's nearest neighbour, gf-divergence-daily, is only
        # 60 min away at 22:15 IST, so the tolerance must stay well under that gap).
        assert _check("2026-09-02T17:00:00") is False

    def test_handles_the_midnight_wraparound_correctly(self):
        # 2026-09-02T17:48:00Z = 23:18 IST -- 3 min past target, not ~23h58m the wrong
        # way round the clock -- must not naively subtract across the day boundary.
        assert _check("2026-09-02T17:48:00") is True

    def test_tolerance_constant_is_narrow_relative_to_the_nearest_neighbouring_job(self):
        # Regression for the code-review finding on the TS side: a tolerance wide enough
        # to overlap with a neighbouring job's own window would let one off-schedule pm2
        # restart pass the guard for both jobs at once. Nearest neighbour is 60 min away.
        assert backup_pg._SCHEDULE_TOLERANCE_MINUTES * 2 < 60
