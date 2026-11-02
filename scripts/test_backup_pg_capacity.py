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
