"""AF-20260920-03: MUTED matched daily_failure_triage.py's `key` (the exact string
runPython(script, ...) was called with) as an exact set member. pythonRunnerMemoryCeiling.test.ts
calls it with path.join('__tests__', 'fixtures', 'mem_hog.py'), which logs as
`__tests__\\fixtures\\mem_hog.py` on Windows -- never equal to the bare `mem_hog.py` in MUTED --
so the mute never fired for the real logged key and the fixture's deliberate crash surfaced in
the daily digest as an untracked step failure every time a session ran `npx vitest run`.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily_failure_triage as dft  # noqa: E402


def test_windows_path_to_a_muted_test_fixture_is_muted():
    assert dft.is_muted(r"__tests__\fixtures\mem_hog.py")


def test_posix_path_to_a_muted_test_fixture_is_muted():
    assert dft.is_muted("__tests__/fixtures/mem_hog.py")


def test_bare_filename_of_a_muted_fixture_is_still_muted():
    assert dft.is_muted("mem_hog.py")


def test_muted_production_fetcher_by_bare_name_is_unaffected():
    assert dft.is_muted("mf_sector_flow_fetcher.py")


def test_a_real_production_script_is_not_muted():
    assert not dft.is_muted("mc_chart_patterns_fetcher.py")
    assert not dft.is_muted(r"src\server\mc_chart_patterns_fetcher.py")


def test_a_fixtures_directory_outside_a_test_dir_is_not_muted():
    # "fixtures" alone is not sufficient -- it must sit under __tests__/ or tests/, matching
    # the real logged shape, or an unrelated data directory named "fixtures" would be silently
    # exempted from ever being reported as a failure.
    assert not dft.is_muted(r"scripts\fixtures\some_real_script.py")


def test_human_report_survives_a_cp1252_console(tmp_path, monkeypatch):
    # 2026-11-11: an app log line carrying the emoji the TS services print crashed the report
    # with UnicodeEncodeError on the default Windows console, so the full list was unreadable.
    import datetime
    import io
    import json
    day = datetime.date.today().isoformat()
    (tmp_path / f"error-{day}.log").write_text(
        json.dumps({"message": "❌ Error fetching Trendlyne screener data: fetch failed"}) + "\n",
        encoding="utf-8")
    monkeypatch.setattr(dft, "LOG_DIR", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["daily_failure_triage.py", "--days", "1"])
    buf = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(buf, encoding="cp1252"))
    assert dft.main() == 1
    sys.stdout.flush()
    assert b"Error fetching Trendlyne screener data" in buf.getvalue()
