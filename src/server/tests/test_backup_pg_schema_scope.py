"""Exercise the actual backup command without Docker, DB writes or pruning."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def backup_module():
    path = Path(__file__).resolve().parents[3] / "scripts" / "backup_pg.py"
    spec = importlib.util.spec_from_file_location("backup_scope_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_backup_excludes_only_disposable_schema_patterns(backup_module, monkeypatch, tmp_path):
    module = backup_module
    commands = []
    heartbeats = []
    monkeypatch.setattr(module, "BACKUP_DIR", tmp_path)
    monkeypatch.setattr(module, "_is_within_schedule_window", lambda: True)
    monkeypatch.setattr(module, "_check_container", lambda: None)
    monkeypatch.setattr(module, "_verify_dump", lambda path: (True, ""))
    monkeypatch.setattr(module, "_prune", lambda: None)
    monkeypatch.setattr(module, "_record_heartbeat", lambda *args: heartbeats.append(args))

    def run(command, **kwargs):
        commands.append(command)
        kwargs["stdout"].write(b"fixture dump")
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr(module.subprocess, "run", run)
    module.backup()

    assert len(commands) == 1
    command = commands[0]
    assert command[command.index("pg_dump"):] == [
        "pg_dump", "-U", module.PG_USER, "-d", module.PG_DB, "-Fc", "--no-owner",
        "--exclude-schema=pytest_[0-9a-f]{12}",
        "--exclude-schema=vitest_[0-9a-f]{12}",
    ]
    assert heartbeats[0][0] is True


def test_failed_dump_is_not_published_or_pruned(backup_module, monkeypatch, tmp_path):
    module = backup_module
    heartbeats = []
    monkeypatch.setattr(module, "BACKUP_DIR", tmp_path)
    monkeypatch.setattr(module, "_is_within_schedule_window", lambda: True)
    monkeypatch.setattr(module, "_check_container", lambda: None)
    monkeypatch.setattr(module, "_record_heartbeat", lambda *args: heartbeats.append(args))

    def unexpected(*args):
        pytest.fail("failed backup must not verify or prune")

    monkeypatch.setattr(module, "_verify_dump", unexpected)
    monkeypatch.setattr(module, "_prune", unexpected)
    monkeypatch.setattr(module.subprocess, "run", lambda *args, **kwargs:
                        SimpleNamespace(returncode=1, stderr=b"dump failure"))
    with pytest.raises(SystemExit, match="dump failure"):
        module.backup()
    assert not list(tmp_path.glob("*.dump"))
    assert heartbeats == [(False, "pg_dump failed: dump failure")]
