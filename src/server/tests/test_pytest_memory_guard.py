"""The gate must reclaim the WSL file cache before it stops, and never move its stop line
(AF-20261030-12)."""
import importlib.util
import os
from pathlib import Path

import pytest

_path = Path(__file__).resolve().parents[3] / "scripts" / "pytest_memory_guard.py"
_spec = importlib.util.spec_from_file_location("pytest_memory_guard", _path)
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

GIB = 1024 ** 3


def test_reclaims_before_the_stop_line_is_reached():
    assert guard.next_action(2.0 * GIB, now=1000, last_reclaim=-60) == "reclaim"


def test_reclaims_early_enough_to_fit_the_scheduled_finbert_run():
    """Stops landed at :00/:15/:30/:45 on whichever test was running: a ~2.5 GB job arriving with
    less than that above the stop line trips the guard however clean the suite is."""
    finbert_peak = 2.5 * GIB
    assert guard.RECLAIM_BELOW >= guard.STOP_BELOW + finbert_peak
    assert guard.next_action(3.5 * GIB, now=1000, last_reclaim=-60) == "reclaim"


def test_does_not_reclaim_again_while_the_last_one_is_settling():
    assert guard.next_action(2.0 * GIB, now=1000, last_reclaim=990) == "wait"


def test_stops_below_the_line_even_when_a_reclaim_is_available():
    """Reclaiming must not become a way to sit under the safety threshold."""
    assert guard.next_action(1.2 * GIB, now=1000, last_reclaim=-60) == "stop"
    assert guard.next_action(1.2 * GIB, now=1000, last_reclaim=999) == "stop"


def test_healthy_host_is_left_alone():
    assert guard.next_action(5 * GIB, now=1000, last_reclaim=-60) == "wait"


def test_the_stop_line_did_not_move():
    assert guard.STOP_BELOW == 1.3 * GIB


@pytest.mark.parametrize("environ", [{}, {"PGTEST_DB": ""}, {"PGTEST_DB": "bharat_intel"}])
def test_refuses_to_run_without_a_dedicated_database(environ):
    with pytest.raises(SystemExit):
        guard.gate_env(environ)


def test_gate_hides_cuda_and_bounds_threads_without_overriding_the_caller():
    env = guard.gate_env({"PGTEST_DB": "t", "OMP_NUM_THREADS": "4"})
    assert env["CUDA_VISIBLE_DEVICES"] == "-1", "an empty value makes dl_engine raise Invalid device id"
    assert env["OMP_NUM_THREADS"] == "4"
    assert env["MKL_NUM_THREADS"] == "2"


def test_gate_can_import_itself_as_the_pytest_plugin():
    env = guard.gate_env({"PGTEST_DB": "t", "PYTHONPATH": "caller"})
    entries = env["PYTHONPATH"].split(os.pathsep)
    assert str(_path.parent) in entries
    assert "caller" in entries, "the caller's own path must survive"


def test_plugin_turns_onednn_off():
    torch = pytest.importorskip("torch")
    before = torch.backends.mkldnn.enabled
    try:
        torch.backends.mkldnn.enabled = True
        guard.pytest_configure(None)
        assert torch.backends.mkldnn.enabled is False
    finally:
        torch.backends.mkldnn.enabled = before
