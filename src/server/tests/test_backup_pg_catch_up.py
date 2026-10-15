"""AF-20261015-08: the 2026-10-14 23:15 IST nightly never fired (host down), the 00:26 IST post-boot
launch was skipped as "off-schedule", and no verified dump existed for 2+ days. An overdue backup
must run at the next launch outside market hours, never inside them."""
import importlib.util
from datetime import datetime
from pathlib import Path

import pytest


@pytest.fixture
def backup_module():
    path = Path(__file__).resolve().parents[3] / "scripts" / "backup_pg.py"
    spec = importlib.util.spec_from_file_location("backup_catch_up_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# 2026-10-15 is a Thursday
def test_overdue_dump_runs_after_a_missed_slot_at_night(backup_module):
    assert backup_module._catch_up_due(datetime(2026, 10, 15, 0, 26), dump_age_hours=28.0)


def test_fresh_dump_is_not_repeated_on_an_off_schedule_launch(backup_module):
    assert not backup_module._catch_up_due(datetime(2026, 10, 15, 0, 26), dump_age_hours=1.0)


def test_overdue_dump_never_starts_inside_market_hours(backup_module):
    assert not backup_module._catch_up_due(datetime(2026, 10, 15, 11, 0), dump_age_hours=60.0)


def test_no_dump_at_all_counts_as_overdue_outside_market_hours(backup_module, tmp_path, monkeypatch):
    monkeypatch.setattr(backup_module, "BACKUP_DIR", tmp_path)
    assert backup_module._newest_dump_age_hours() is None
    assert backup_module._catch_up_due(datetime(2026, 10, 17, 11, 0))   # Saturday
