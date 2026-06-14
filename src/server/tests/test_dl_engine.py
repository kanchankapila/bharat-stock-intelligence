import sys
import os
import inspect
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))

import torch
from src.server.dl_engine import BiLSTMModel, N_FEATURES, _predict_batch


class TestSoftmaxBug:
    def test_forward_returns_raw_logits(self):
        """dir_5d from forward() should be raw logits, NOT softmax probabilities."""
        model = BiLSTMModel()
        x = torch.randn(2, 60, N_FEATURES)
        out = model(x)
        dir5 = out["dir_5d"]

        # Softmax output: all values in [0,1] AND each row sums to ~1
        probs_like = bool((dir5 >= 0).all() and (dir5 <= 1).all())
        row_sums = dir5.sum(dim=-1)
        sums_to_one = bool(
            torch.allclose(row_sums, torch.ones_like(row_sums), atol=0.01)
        )
        assert not (probs_like and sums_to_one), (
            "dir_5d looks like softmax output (values in [0,1], rows sum to 1) "
            "— forward() should return raw logits for CrossEntropyLoss"
        )

    def test_forward_returns_raw_logits_all_dir_heads(self):
        """All three dir_* heads must return raw logits."""
        model = BiLSTMModel()
        x = torch.randn(4, 60, N_FEATURES)
        out = model(x)
        for key in ("dir_1d", "dir_5d", "dir_15d"):
            t = out[key]
            probs_like = bool((t >= 0).all() and (t <= 1).all())
            sums_to_one = bool(
                torch.allclose(t.sum(dim=-1), torch.ones(4), atol=0.01)
            )
            assert not (probs_like and sums_to_one), (
                f"{key} looks like softmax output — should be raw logits"
            )

    def test_regression_heads_unchanged(self):
        """ret_5d and ret_15d should still return scalars (not affected by fix)."""
        model = BiLSTMModel()
        x = torch.randn(3, 60, N_FEATURES)
        out = model(x)
        assert out["ret_5d"].shape == (3,), "ret_5d should be shape (batch,)"
        assert out["ret_15d"].shape == (3,), "ret_15d should be shape (batch,)"

    def test_predict_batch_returns_probabilities(self):
        """_predict_batch should apply softmax so dir values are in [0,1] and rows sum to 1."""
        model = BiLSTMModel()
        X = np.random.randn(5, 60, N_FEATURES).astype(np.float32)
        preds = _predict_batch(model, X)
        for key in ("dir_1d", "dir_5d", "dir_15d"):
            arr = preds[key]
            assert arr.shape == (5, 2), f"{key} should have shape (5, 2)"
            assert (arr >= 0).all() and (arr <= 1).all(), (
                f"{key} values should be in [0,1] after softmax in _predict_batch"
            )
            row_sums = arr.sum(axis=-1)
            np.testing.assert_allclose(
                row_sums, np.ones(5), atol=0.01,
                err_msg=f"{key} rows should sum to 1 after softmax",
            )


class TestTrainingCorpus:
    def test_no_symbol_cap(self):
        """train_lstm must not reference MAX_TRAIN_SYMBOLS cap."""
        import src.server.dl_engine as mod
        train_fn_src = inspect.getsource(mod.train_lstm)
        assert "MAX_TRAIN_SYMBOLS" not in train_fn_src, (
            "train_lstm still references MAX_TRAIN_SYMBOLS — cap must be removed"
        )

    def test_no_random_sampling(self):
        """train_lstm must not randomly sample symbols (rng.choice)."""
        import src.server.dl_engine as mod
        train_fn_src = inspect.getsource(mod.train_lstm)
        assert "rng.choice" not in train_fn_src, (
            "train_lstm still uses rng.choice to subsample symbols"
        )

    def test_module_has_no_max_train_symbols_constant(self):
        """MAX_TRAIN_SYMBOLS constant must not exist at module level."""
        import src.server.dl_engine as mod
        assert not hasattr(mod, "MAX_TRAIN_SYMBOLS"), (
            "MAX_TRAIN_SYMBOLS constant still exists at module level"
        )

    def test_chunked_constant_exists(self):
        """_CHUNK_SIZE constant should exist to define chunked training batch size."""
        import src.server.dl_engine as mod
        assert hasattr(mod, "_CHUNK_SIZE"), (
            "_CHUNK_SIZE constant should be defined for chunked symbol streaming"
        )
        assert isinstance(mod._CHUNK_SIZE, int) and mod._CHUNK_SIZE > 0
