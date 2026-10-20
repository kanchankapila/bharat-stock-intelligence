"""Only fully read-back-verified backups may have the retained .dump extension."""
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
import backup_pg  # noqa: E402


def test_verified_backup_is_published_atomically(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_pg, "BACKUP_DIR", tmp_path)
    monkeypatch.setattr(backup_pg, "_check_container", lambda: None)
    monkeypatch.setattr(backup_pg, "_prune", lambda: None)
    monkeypatch.setattr(backup_pg, "_record_heartbeat", lambda *_args: None)

    def fake_dump(_cmd, *, stdout, stderr):
        stdout.write(b"complete backup")
        return SimpleNamespace(returncode=0, stderr=b"")

    def fake_verify(path):
        assert path.suffix == ".partial"
        assert not list(tmp_path.glob("*.dump"))
        return True, ""

    monkeypatch.setattr(backup_pg.subprocess, "run", fake_dump)
    monkeypatch.setattr(backup_pg, "_verify_dump", fake_verify)
    backup_pg._backup_under_lock()
    assert len(list(tmp_path.glob("*.dump"))) == 1
    assert not list(tmp_path.glob("*.partial"))


def test_interrupted_dump_cannot_appear_in_retained_set(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_pg, "BACKUP_DIR", tmp_path)
    monkeypatch.setattr(backup_pg, "_check_container", lambda: None)

    def interrupted_dump(_cmd, *, stdout, stderr):
        stdout.write(b"unfinished backup")
        raise KeyboardInterrupt

    monkeypatch.setattr(backup_pg.subprocess, "run", interrupted_dump)
    with pytest.raises(KeyboardInterrupt):
        backup_pg._backup_under_lock()
    assert not list(tmp_path.glob("*.dump"))
    assert len(list(tmp_path.glob("*.partial"))) == 1


def test_new_run_never_overwrites_same_second_backup(tmp_path, monkeypatch):
    monkeypatch.setattr(backup_pg, "BACKUP_DIR", tmp_path)
    monkeypatch.setattr(backup_pg, "_check_container", lambda: None)
    monkeypatch.setattr(backup_pg, "_prune", lambda: None)
    monkeypatch.setattr(backup_pg, "_record_heartbeat", lambda *_args: None)
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 17, 21, 0, 0)

    monkeypatch.setattr(backup_pg, "datetime", FixedDatetime)
    existing = tmp_path / f"{backup_pg.PG_DB}_20261017_210000.dump"
    existing.write_bytes(b"previous verified backup")

    def fake_dump(_cmd, *, stdout, stderr):
        stdout.write(b"new verified backup")
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr(backup_pg.subprocess, "run", fake_dump)
    monkeypatch.setattr(backup_pg, "_verify_dump", lambda _path: (True, ""))
    backup_pg._backup_under_lock()
    assert existing.read_bytes() == b"previous verified backup"
    assert len(list(tmp_path.glob("*.dump"))) == 2
