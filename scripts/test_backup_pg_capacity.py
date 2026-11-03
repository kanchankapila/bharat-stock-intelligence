import os
from pathlib import Path
from unittest.mock import patch

import backup_pg


def test_insufficient_headroom_is_reported_before_dump(tmp_path):
    (tmp_path / 'bharat_intel_20261028.dump').write_bytes(b'x' * 100)
    usage = type('Usage', (), {'free': 300})()
    with patch.object(backup_pg, 'BACKUP_DIR', tmp_path), \
         patch.object(backup_pg, 'PG_DB', 'bharat_intel'), \
         patch.object(backup_pg, 'BACKUP_RESERVE_BYTES', 200), \
         patch('backup_pg.shutil.disk_usage', return_value=usage):
        error = backup_pg._capacity_problem()
    assert error is not None
    assert 'free' in error.lower()


def test_capacity_check_allows_sufficient_headroom(tmp_path):
    (tmp_path / 'bharat_intel_20261028.dump').write_bytes(b'x' * 100)
    usage = type('Usage', (), {'free': 401})()
    with patch.object(backup_pg, 'BACKUP_DIR', tmp_path), \
         patch.object(backup_pg, 'PG_DB', 'bharat_intel'), \
         patch.object(backup_pg, 'BACKUP_RESERVE_BYTES', 200), \
         patch('backup_pg.shutil.disk_usage', return_value=usage):
        assert backup_pg._capacity_problem() is None


def _seed(tmp_path, count, size=100):
    names = [f'bharat_intel_202610{day:02d}.dump' for day in range(1, count + 1)]
    for day, name in enumerate(names, start=1):
        path = tmp_path / name
        path.write_bytes(b'x' * size)
        os.utime(path, (1_700_000_000 + day * 100, 1_700_000_000 + day * 100))
    (tmp_path / 'repair_20261009_pre.dump').write_bytes(b'x' * size)
    (tmp_path / 'bharat_intel_x.dump.partial').write_bytes(b'x' * size)
    (tmp_path / 'notes.csv').write_bytes(b'x' * size)
    return names


def _make_room(tmp_path, base_free, reserve=200):
    """disk_usage that grows as archives disappear, like a real disk."""
    start = sum(p.stat().st_size for p in tmp_path.iterdir())

    def usage(_path):
        now = sum(p.stat().st_size for p in tmp_path.iterdir())
        return type('Usage', (), {'free': base_free + start - now})()

    with patch.object(backup_pg, 'BACKUP_DIR', tmp_path), \
         patch.object(backup_pg, 'PG_DB', 'bharat_intel'), \
         patch.object(backup_pg, 'RETENTION', 7), \
         patch.object(backup_pg, 'BACKUP_RESERVE_BYTES', reserve), \
         patch('backup_pg.shutil.disk_usage', side_effect=usage):
        deleted = backup_pg._make_room_for_backup()
        return deleted, backup_pg._capacity_problem()


def _survivors(tmp_path):
    return {p.name for p in tmp_path.iterdir()}


def _others_survive(tmp_path):
    assert {'repair_20261009_pre.dump', 'bharat_intel_x.dump.partial', 'notes.csv'} <= _survivors(tmp_path)


def test_short_space_prunes_only_over_retention_archive(tmp_path):
    names = _seed(tmp_path, 7)
    deleted, problem = _make_room(tmp_path, base_free=399)  # required 400
    assert [p.name for p in deleted] == [names[0]]
    assert problem is None
    assert set(names[1:]) <= _survivors(tmp_path)
    _others_survive(tmp_path)


def test_prune_cannot_cover_shortfall_deletes_nothing(tmp_path):
    names = _seed(tmp_path, 7)
    deleted, problem = _make_room(tmp_path, base_free=299)  # 299 + 100 < 400
    assert deleted == []
    assert 'Insufficient backup disk free space' in problem
    assert set(names) <= _survivors(tmp_path)
    _others_survive(tmp_path)


def test_enough_space_deletes_nothing(tmp_path):
    names = _seed(tmp_path, 7)
    deleted, problem = _make_room(tmp_path, base_free=400)
    assert deleted == []
    assert problem is None
    assert set(names) <= _survivors(tmp_path)
    _others_survive(tmp_path)


def test_below_retention_count_deletes_nothing(tmp_path):
    names = _seed(tmp_path, 6)
    deleted, problem = _make_room(tmp_path, base_free=399)
    assert deleted == []
    assert problem is not None
    assert set(names) <= _survivors(tmp_path)
    _others_survive(tmp_path)


def _run_backup(tmp_path, base_free):
    """_backup_under_lock with the container, dump, verification, prune and heartbeat stubbed; disk_usage tracks tmp_path."""
    start = sum(p.stat().st_size for p in tmp_path.iterdir())

    def usage(_path):
        now = sum(p.stat().st_size for p in tmp_path.iterdir())
        return type('Usage', (), {'free': base_free + start - now})()

    beats = []
    with patch.object(backup_pg, 'BACKUP_DIR', tmp_path), \
         patch.object(backup_pg, 'PG_DB', 'bharat_intel'), \
         patch.object(backup_pg, 'RETENTION', 7), \
         patch.object(backup_pg, 'BACKUP_RESERVE_BYTES', 200), \
         patch('backup_pg.shutil.disk_usage', side_effect=usage), \
         patch.object(backup_pg, '_check_container'), \
         patch.object(backup_pg, '_verify_dump', return_value=(True, '')), \
         patch.object(backup_pg, '_prune'), \
         patch.object(backup_pg, '_record_heartbeat', side_effect=lambda ok, detail: beats.append((ok, detail))), \
         patch('backup_pg.subprocess.run', return_value=type('Proc', (), {'returncode': 0, 'stderr': b''})()):
        backup_pg._backup_under_lock()
    return beats


def test_short_space_that_pruning_fixes_is_pruned_before_the_capacity_check_not_refused(tmp_path):
    names = _seed(tmp_path, 7)
    beats = _run_backup(tmp_path, base_free=399)            # required 400: only fits after the over-retention archive goes
    assert [ok for ok, _ in beats] == [True]
    assert not (tmp_path / names[0]).exists()


def test_a_dump_that_needed_a_forced_prune_says_so_in_its_heartbeat_detail(tmp_path):
    names = _seed(tmp_path, 7)
    forced = _run_backup(tmp_path, base_free=399)[0][1]
    assert f'freed {names[0]} to fit' in forced
    healthy = _run_backup(tmp_path, base_free=10_000)[0][1]
    assert 'freed' not in healthy
