"""train_lstm's training budget, symbol order and coverage report (AF-20260927-20).

The load deadline used to run while a chunk trained, so it stopped every retrain at exactly
207 of ~2,200 symbols -- the alphabetical head of the universe -- and the run still read
success. Lifting that alone would turn a ~3h job into roughly 18h, so the wall-clock bound is
now its own budget, and the sample it leaves is reported and not alphabetical.
"""
import os
import sys
import time
import types
from unittest.mock import patch

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dl_engine

if dl_engine.torch is None:
    pytest.skip("torch not installed", allow_module_level=True)

SYMBOLS = [f"S{i:03d}" for i in range(120)]


def _fake_batch():
    X = np.random.randn(4, 60, dl_engine.N_FEATURES).astype(np.float32)
    y = np.zeros(4, dtype=np.int64)
    return X, y, y.copy(), np.zeros(4, dtype=np.float32)


class _Conn:
    def execute(self, *a, **k):
        class _Cur:
            def fetchall(self):
                return [(s,) for s in SYMBOLS]
        return _Cur()

    def close(self):
        pass


@pytest.fixture
def run_train(monkeypatch, tmp_path):
    calls = {"loads": [], "closed": 0}

    def _stub_loader(symbols, loader, *a, **k):
        calls["loads"].append(list(symbols))
        phase = len(calls["loads"])
        try:
            for _ in symbols:
                batch = _fake_batch()
                yield batch if phase == 1 else (*batch, ["2026-01-01"] * 4)
        finally:
            if phase == 1:
                calls["closed"] += 1

    monkeypatch.setattr(dl_engine, "connect", lambda: _Conn())
    monkeypatch.setattr(dl_engine, "MODEL_DIR", tmp_path)
    monkeypatch.setattr(dl_engine, "_CHUNK_SIZE", 10)
    monkeypatch.setattr(dl_engine, "load_sequences_bounded", _stub_loader)
    monkeypatch.setattr(dl_engine, "walk_forward_validate",
                        lambda *a, **k: {"directional_accuracy": 0.5, "roc_auc": 0.5})
    monkeypatch.setattr(dl_engine, "serve_saturation", lambda *a, **k: 0.1)
    stub_dd = types.ModuleType("drift_detector")
    stub_dd.write_training_metrics = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "drift_detector", stub_dd)

    def _run(fold=lambda *a, **k: None, budget="0", version=990002):
        monkeypatch.setenv("DL_TRAIN_BUDGET_SEC", budget)
        calls["loads"].clear()
        with patch.object(dl_engine, "_train_one_fold", side_effect=fold):
            return dl_engine.train_lstm(version=version), calls

    return _run


def test_unbudgeted_run_reports_full_coverage(run_train):
    metrics, _ = run_train()
    assert metrics["symbols_requested"] == 120
    assert metrics["symbols_trained"] == 120
    assert metrics["training_coverage"] == 1.0
    assert metrics["training_stop_reason"] is None


def test_train_budget_stops_at_a_chunk_boundary_and_says_so(run_train, capsys):
    fits = []

    def fold(*a, **k):
        fits.append(len(a[1]))
        time.sleep(0.03)  # past the budget on Windows' 15.6ms monotonic tick

    metrics, calls = run_train(fold=fold, budget="0.001")
    assert len(fits) == 1, "must stop after the chunk that crossed the budget, not mid-chunk"
    assert metrics["symbols_trained"] == 10
    assert metrics["training_coverage"] == pytest.approx(10 / 120)
    assert metrics["training_stop_reason"] == "train_budget"
    assert calls["closed"] == 1, "the loader must be closed, not left holding loaded symbols"
    assert "10 of 120" in capsys.readouterr().err


def test_training_order_is_not_alphabetical_and_is_reproducible(run_train):
    """A budget that cuts the run has to leave a sample of the universe, not its A-names."""
    _, calls = run_train(version=990003)
    first = list(calls["loads"][0])
    assert sorted(first) == SYMBOLS
    assert first != SYMBOLS
    _, calls = run_train(version=990003)
    assert calls["loads"][0] == first


def test_validation_panel_stays_the_sorted_head(run_train):
    """roc_auc is compared against the champion's, so its 50 names must not move with the sample."""
    _, calls = run_train()
    assert calls["loads"][1] == SYMBOLS[:50]


def test_oom_skipped_chunk_is_not_counted_as_trained(run_train):
    seen = {"n": 0}

    def fold(*a, **k):
        seen["n"] += 1
        if seen["n"] <= 2:
            raise RuntimeError("CUDA error: out of memory")

    metrics, _ = run_train(fold=fold)
    assert metrics["symbols_requested"] == 120
    assert metrics["symbols_trained"] == 110
