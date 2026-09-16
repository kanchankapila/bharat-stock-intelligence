"""Per-job memory ceiling for runPython children (src/server/pyboot/sitecustomize.py).

2026-09-06..09-11: dl_trainer.py (a runPython child of bharat-server, so pm2's
max_memory_restart never saw it) reached 38-52.7GB of commit on a 24GB host, exhausted
Windows commit, and killed the WSL2 VM -- and the database with it -- three times. The guard
puts every runPython child in a Windows Job Object with a memory ceiling, so the next runaway
fails ITS job with a MemoryError instead of taking the whole box down.

These spawn real interpreters: a Job Object limit is kernel behaviour, and a mocked test of it
would prove nothing.
"""
import json
import os
import subprocess
import sys
import textwrap

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Objects only")

PYBOOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pyboot")

ALLOC = textwrap.dedent("""
    import sys
    mb = int(sys.argv[1])
    blocks = [bytearray(50 * 1024 * 1024) for _ in range(max(1, mb // 50))]
    print("allocated", mb)
""")


def _run(code, *args, env_extra=None, strip_guard_env=True):
    env = {k: v for k, v in os.environ.items()
           if not (strip_guard_env and k.startswith("BHARAT_PY_"))}
    env["PYTHONPATH"] = PYBOOT
    env.update(env_extra or {})
    return subprocess.run([sys.executable, "-c", code, *map(str, args)],
                          env=env, capture_output=True, text=True, timeout=120)


def test_runaway_allocation_fails_with_memoryerror_under_the_ceiling():
    r = _run(ALLOC, 800, env_extra={"BHARAT_PY_MEM_LIMIT_MB": "300"})
    assert r.returncode != 0
    assert "MemoryError" in r.stderr


def test_allocation_within_the_ceiling_runs_normally():
    r = _run(ALLOC, 100, env_extra={"BHARAT_PY_MEM_LIMIT_MB": "300"})
    assert r.returncode == 0, r.stderr
    assert "allocated 100" in r.stdout


def test_without_the_limit_env_the_same_allocation_succeeds():
    # Control: proves the failure above is the guard, not this box running out of memory.
    r = _run(ALLOC, 800)
    assert r.returncode == 0, r.stderr


def test_a_grandchild_counts_against_the_parents_ceiling():
    # daily_ml_update.py / feature_engineering.py spawn their own interpreters; a ceiling the
    # grandchild escapes (by creating its own fresh job) would not protect the host.
    parent = textwrap.dedent(f"""
        import subprocess, sys
        r = subprocess.run([sys.executable, "-c", {ALLOC!r}, "500"],
                           capture_output=True, text=True)
        print("child_rc", r.returncode)
        print("child_memerr", "MemoryError" in r.stderr)
    """)
    r = _run(parent, env_extra={"BHARAT_PY_MEM_LIMIT_MB": "300"})
    assert r.returncode == 0, r.stderr
    assert "child_memerr True" in r.stdout, r.stdout


def test_descendants_stay_in_the_job_without_rewriting_the_tree_peak(tmp_path):
    # The tree peak is the parent job's to report; a child left holding the env vars would build
    # its own nested job and overwrite the record with its own smaller peak.
    peak_file = tmp_path / "peak.json"
    parent = textwrap.dedent(f"""
        import os, subprocess, sys
        child = subprocess.run([sys.executable, "-c",
            "import os; print(os.environ.get('BHARAT_PY_PEAK_FILE')); " + {ALLOC!r}, "300"],
            capture_output=True, text=True)
        print("child_saw", child.stdout.split()[0])
    """)
    r = _run(parent, env_extra={"BHARAT_PY_MEM_LIMIT_MB": "2000",
                                "BHARAT_PY_PEAK_FILE": str(peak_file)})
    assert r.returncode == 0, r.stderr
    assert "child_saw None" in r.stdout
    assert json.loads(peak_file.read_text())["peak_mb"] >= 300


def test_peak_memory_is_recorded_for_the_runner(tmp_path):
    peak_file = tmp_path / "peak.json"
    r = _run(ALLOC, 200, env_extra={"BHARAT_PY_MEM_LIMIT_MB": "1000",
                                    "BHARAT_PY_PEAK_FILE": str(peak_file)})
    assert r.returncode == 0, r.stderr
    rec = json.loads(peak_file.read_text())
    assert rec["limit_mb"] == 1000
    assert 200 <= rec["peak_mb"] < 1000


def test_peak_is_recorded_even_when_the_job_dies_of_memoryerror(tmp_path):
    peak_file = tmp_path / "peak.json"
    r = _run(ALLOC, 800, env_extra={"BHARAT_PY_MEM_LIMIT_MB": "300",
                                    "BHARAT_PY_PEAK_FILE": str(peak_file)})
    assert r.returncode != 0
    assert json.loads(peak_file.read_text())["peak_mb"] >= 290


@pytest.mark.parametrize("bad", ["abc", "-5", "0", ""])
def test_an_unusable_limit_value_fails_open(bad):
    r = _run(ALLOC, 100, env_extra={"BHARAT_PY_MEM_LIMIT_MB": bad})
    assert r.returncode == 0, r.stderr
    # An exception escaping sitecustomize is printed by Python itself on every job's stderr.
    assert "Error in sitecustomize" not in r.stderr
