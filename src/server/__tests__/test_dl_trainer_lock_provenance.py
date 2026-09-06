"""dl-retrain's lock must not outlive the process that acquired it.

Live 2026-09-06: dl-retrain-weekly ran 14h48m on 2026-09-05 starting 18:02:43, was killed by an
UNRELATED pm2 restart at ~08:53 IST the next morning (its OS PID, 44900, confirmed gone -- see
AF-20260906-01/reclaimStaleActiveJobs, the identical class one layer up at the BullMQ level).
~22 hours after acquisition -- well under STALE_LOCK_SECONDS=25h -- a fresh attempt was refused:
"[TRAINER] Retrain already running -- skipping", returning success in 4 seconds having done
nothing. Wall-clock alone cannot distinguish a genuinely long retrain (this job has legitimately
run past 14h) from a dead one; PID existence can, and dl_trainer.py runs as its own OS process
(spawned by runPython), so its PID is exactly what a lock needs to record.

lock_is_stale() checks PID liveness FIRST -- provenance over elapsed time, matching
registerJob.ts's isStaleActiveJob for the same reason -- and falls back to the wall-clock
STALE_LOCK_SECONDS only when no PID was recorded (an old lock row, or a caller that could not
determine its own PID).
"""
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dl_trainer import lock_is_stale, STALE_LOCK_SECONDS


def test_a_lock_whose_owner_pid_is_gone_is_stale_immediately():
    """The live incident: 22h old, well under the 25h wall-clock window, but the owning
    process no longer exists."""
    now = datetime(2026, 9, 6, 16, 0, 0)
    acquired = (now - timedelta(hours=22)).isoformat()
    assert lock_is_stale(acquired, owner_pid=44900, now=now, pid_alive=lambda pid: False) is True


def test_a_lock_whose_owner_pid_is_still_alive_is_not_stale_however_old():
    """The other half of the same fix: a genuinely long-running retrain (this job has run
    14h48m for real) must not be killed out from under itself by an impatient wall-clock check."""
    now = datetime(2026, 9, 6, 16, 0, 0)
    acquired = (now - timedelta(hours=23)).isoformat()  # under 25h, and the PID IS alive
    assert lock_is_stale(acquired, owner_pid=44900, now=now, pid_alive=lambda pid: True) is False


def test_falls_back_to_wall_clock_when_no_pid_was_recorded():
    """Old lock rows written before this fix have no owner_pid. Must not treat every one of
    them as instantly stale (that would defeat mutual exclusion entirely) or permanently held."""
    now = datetime(2026, 9, 6, 16, 0, 0)
    fresh = (now - timedelta(hours=1)).isoformat()
    old = (now - timedelta(seconds=STALE_LOCK_SECONDS + 60)).isoformat()
    assert lock_is_stale(fresh, owner_pid=None, now=now, pid_alive=lambda pid: True) is False
    assert lock_is_stale(old, owner_pid=None, now=now, pid_alive=lambda pid: True) is True


def test_a_missing_or_unparseable_timestamp_is_stale():
    assert lock_is_stale(None, owner_pid=123, now=datetime.now(), pid_alive=lambda pid: True) is True
    assert lock_is_stale("not-a-date", owner_pid=123, now=datetime.now(), pid_alive=lambda pid: True) is True


def test_pid_zero_or_negative_is_treated_as_unrecorded_not_as_a_real_process():
    """0/-1 are never real PIDs; a caller that failed to determine its own PID must fall back
    to the wall-clock path rather than passing a sentinel through to pid_alive()."""
    now = datetime(2026, 9, 6, 16, 0, 0)
    fresh = (now - timedelta(hours=1)).isoformat()
    assert lock_is_stale(fresh, owner_pid=0, now=now, pid_alive=lambda pid: False) is False
    assert lock_is_stale(fresh, owner_pid=-1, now=now, pid_alive=lambda pid: False) is False
