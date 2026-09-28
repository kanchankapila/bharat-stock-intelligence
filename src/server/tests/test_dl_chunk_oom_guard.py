"""AF-20260927-20: CUDA-OOM resilience in train_lstm's chunk loop.

This platform trains on an 8GB GeForce in WDDM mode, where the Windows desktop shares VRAM,
so a chunk fold can die with cudaErrorMemoryAllocation even when the same chunk trained fine
an hour earlier. Both live dl-retrain-weekly failures on 2026-09-27 died exactly there --
~2.7h runs lost to one fold's OOM, with `job_run_history` recording nothing but benign torch
warnings. The guard (same trade load_sequences_bounded already makes per symbol):
empty_cache + one retry; a second OOM skips the CHUNK loudly (stderr) and the run continues.

These tests pin that behavior on CPU -- the OOM is simulated by a stub _train_one_fold
raising RuntimeError("CUDA error: out of memory"); no CUDA required.
"""
import sys
import os
import types
from unittest.mock import patch

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))

import src.server.dl_engine as dl_engine


def _fake_batch(n_seqs=5, seq_len=20, n_feat=8):
    X = np.random.randn(n_seqs, seq_len, n_feat).astype(np.float32)
    y5 = np.random.randint(0, 2, n_seqs).astype(np.int64)
    y15 = np.random.randint(0, 2, n_seqs).astype(np.int64)
    yr5 = np.random.randn(n_seqs).astype(np.float32)
    return X, y5, y15, yr5


class _StubConn:
    def execute(self, *a, **k):
        class _Cur:
            def fetchall(self):
                return [("SYM1",), ("SYM2",), ("SYM3",)]
        return _Cur()

    def close(self):
        pass


def _run_train_lstm(monkeypatch, tmp_path, fold):
    """Stub DB + loader + fold trainer + persistence; return train_lstm's result dict."""
    monkeypatch.setattr(dl_engine, "connect", lambda: _StubConn())
    monkeypatch.setattr(dl_engine, "MODEL_DIR", tmp_path)

    def _stub_loader(symbols, loader, max_workers=4, deadline=None, max_in_flight=None):
        # The training loop unpacks 4-tuples (X, y5, y15, yr5); the walk-forward val loop
        # unpacks 5 (…, dates). The two phases call this loader in order, so key the shape
        # off the call count.
        _stub_loader.calls += 1
        if _stub_loader.calls == 1:
            for _ in symbols:
                yield _fake_batch()
        else:
            for _ in symbols:
                X, y5, y15, yr5 = _fake_batch()
                dates = [f"2026-01-{i+1:02d}" for i in range(len(X))]
                yield X, y5, y15, yr5, dates
    _stub_loader.calls = 0

    monkeypatch.setattr(dl_engine, "load_sequences_bounded", _stub_loader)
    monkeypatch.setattr(dl_engine, "walk_forward_validate",
                        lambda *a, **k: {"directional_accuracy": 0.5, "roc_auc": 0.5})
    monkeypatch.setattr(dl_engine, "serve_saturation", lambda *a, **k: 0.1)
    stub_dd = types.ModuleType("drift_detector")
    stub_dd.write_training_metrics = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, "drift_detector", stub_dd)

    with patch.object(dl_engine, "_train_one_fold", side_effect=fold):
        return dl_engine.train_lstm(version=990001)


class TestChunkOomGuard:
    def test_oom_retried_once_then_succeeds(self, monkeypatch, tmp_path, capsys):
        """First fold attempt OOMs, retry succeeds -> run completes, no chunk lost."""
        calls = {"n": 0}

        def fold(*a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("CUDA error: out of memory")
            return None

        result = _run_train_lstm(monkeypatch, tmp_path, fold)
        assert calls["n"] == 2, "the chunk must be retried exactly once, not abandoned"
        assert "error" not in result
        assert "CUDA OOM" in capsys.readouterr().err

    def test_double_oom_skips_chunk_and_run_continues(self, monkeypatch, tmp_path, capsys):
        """Both attempts OOM -> the chunk is skipped loudly; the run still completes."""
        def fold(*a, **k):
            raise RuntimeError("CUDA error: out of memory")

        result = _run_train_lstm(monkeypatch, tmp_path, fold)
        assert "error" not in result, "a chunk OOM must not abort the multi-hour run"
        err = capsys.readouterr().err
        assert "SKIPPING" in err
        assert "run continues on the rest" in err
        assert "chunk(s) were skipped" in err

    def test_non_oom_runtime_error_still_raises(self, monkeypatch, tmp_path):
        """A non-OOM RuntimeError must NOT be swallowed -- it still fails the run loudly."""

        def fold(*a, **k):
            raise RuntimeError("shape mismatch")

        with pytest.raises(RuntimeError, match="shape mismatch"):
            _run_train_lstm(monkeypatch, tmp_path, fold)
