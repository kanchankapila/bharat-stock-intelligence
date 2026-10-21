"""A killed pg_dump leaves a ~5.8 GB `.dump.partial` that `_prune`'s `*.dump` glob never matched."""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
import backup_pg  # noqa: E402


def _file(directory: Path, name: str, age_hours: float) -> Path:
    p = directory / name
    p.write_bytes(b"x")
    t = time.time() - age_hours * 3600
    os.utime(p, (t, t))
    return p


def test_stale_partial_is_pruned_but_fresh_and_verified_dumps_survive(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_pg, "BACKUP_DIR", tmp_path)
    monkeypatch.setattr(backup_pg, "RETENTION", 7)
    db = backup_pg.PG_DB
    stale = _file(tmp_path, f"{db}_20261001_231500.dump.partial", 8)
    fresh = _file(tmp_path, f"{db}_20261020_231500.dump.partial", 0.5)
    dumps = [_file(tmp_path, f"{db}_2026101{i}_231500.dump", 30 * i) for i in range(1, 4)]
    truncated = _file(tmp_path, f"{db}_20260910_231501.dump.TRUNCATED", 999)

    with backup_pg._backup_lock(tmp_path / "backup.lock", wait_seconds=0) as held:
        assert held  # _prune only runs under the backup lock, so no OTHER dump can be in flight
        backup_pg._prune()

    assert not stale.exists()
    assert fresh.exists()
    assert all(d.exists() for d in dumps)
    assert truncated.exists()
