"""backup_pg._verify_dump must reject a TRUNCATED dump, not just an unreadable one.

2026-09-10's nightly dump was cut off at 1.55GB (full dumps run 4.2-4.4GB) when the WSL2 VM
died mid-dump, and it stayed in the retention set looking like a good backup. Measured against
that real file: `pg_restore --list` read it cleanly and listed 496 TABLE DATA entries -- a
custom-format dump streamed to stdout writes its table of contents FIRST, so a TOC check cannot
see a missing tail. Only reading the data blocks does: `pg_restore -f /dev/null` failed on it
with "could not read from input file: end of file" (rc=1) and passed the good 4.2GB dump in 289s.
"""
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backup_pg  # noqa: E402

_TOC = "; Archive created at ...\n1234; 0 16500 TABLE DATA public stock_ohlcv bharat\n"


def _fake_run(truncated: bool):
    def run(cmd, **kwargs):
        if "--list" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout=_TOC, stderr="")
        if truncated:
            return subprocess.CompletedProcess(
                cmd, 1, stdout="", stderr="pg_restore: error: could not read from input file: end of file\n")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return run


def test_truncated_dump_with_a_readable_toc_is_rejected(tmp_path):
    dump = tmp_path / "bharat_intel_20260910_231501.dump"
    dump.write_bytes(b"PGDMP")
    with patch("backup_pg.subprocess.run", side_effect=_fake_run(truncated=True)):
        ok, err = backup_pg._verify_dump(dump)
    assert ok is False
    assert "end of file" in err


def test_complete_dump_passes(tmp_path):
    dump = tmp_path / "bharat_intel_20260911_082424.dump"
    dump.write_bytes(b"PGDMP")
    with patch("backup_pg.subprocess.run", side_effect=_fake_run(truncated=False)):
        ok, err = backup_pg._verify_dump(dump)
    assert ok is True, err
