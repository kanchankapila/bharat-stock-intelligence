import sys
import os
import inspect
from unittest.mock import patch, MagicMock
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))

import torch
import src.server.dl_engine as dl_engine
from src.server.dl_engine import BiLSTMModel, N_FEATURES, _predict_batch, _train_one_fold, _resolve_prediction_date


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


class TestDir15dTraining:
    def test_train_one_fold_accepts_y15_parameter(self):
        """_train_one_fold must accept a y15 keyword argument to train the dir_15d head."""
        sig = inspect.signature(_train_one_fold)
        assert "y15" in sig.parameters, (
            "_train_one_fold must have a y15 parameter to train the dir_15d classification head"
        )

    def test_train_one_fold_trains_dir_15d_when_y15_provided(self):
        """dir_15d head weights must change after _train_one_fold is called with y15."""
        model = BiLSTMModel()
        weights_before = model.head_dir_15d.weight.data.clone()

        N = 200
        X   = np.random.randn(N, 60, N_FEATURES).astype(np.float32)
        y5  = np.random.randint(0, 2, N).astype(np.int64)
        y15 = np.random.randint(0, 2, N).astype(np.int64)
        yr5 = np.random.randn(N).astype(np.float32)

        _train_one_fold(model, X, y5, yr5, epochs=2, y15=y15)

        # _train_one_fold moves the model to DEVICE in-place; compare on CPU.
        weights_after = model.head_dir_15d.weight.data.cpu()
        assert not torch.allclose(weights_before, weights_after), (
            "dir_15d head weights did not change — y15 loss term is not updating it"
        )

    def test_train_one_fold_y15_none_does_not_crash(self):
        """_train_one_fold must work normally when y15 is omitted (backward compat)."""
        model = BiLSTMModel()
        N = 150
        X   = np.random.randn(N, 60, N_FEATURES).astype(np.float32)
        y5  = np.random.randint(0, 2, N).astype(np.int64)
        yr5 = np.random.randn(N).astype(np.float32)
        # Should not raise
        _train_one_fold(model, X, y5, yr5, epochs=1)


class TestLoadSymbolSequencesLabelRange:
    """Regression: stored target_dir_5d/target_dir_15d columns held legacy values outside
    {0,1} (observed live: -4,-2,-1,2,4) — CrossEntropyLoss on the 2-class dir heads then
    crashes with a CUDA 't >= 0 && t < n_classes' assertion. load_symbol_sequences must
    derive labels from target_ret_5d/target_ret_15d instead of trusting the stored columns.
    """

    def test_labels_derived_from_return_sign_ignore_corrupt_dir_columns(self):
        import pandas as pd
        import src.server.dl_engine as mod

        n = mod.SEQUENCE_LEN + 5
        feat_cols = mod.FEATURE_COLS[:mod.N_FEATURES]
        numeric_cols = [c for c in feat_cols if c not in mod._VOL_ONEHOT]
        data = {c: np.random.randn(n) for c in numeric_cols}
        data["date"] = pd.date_range("2024-01-01", periods=n).strftime("%Y-%m-%d")
        data["vol_regime"] = ["MED"] * n
        # Corrupt legacy target_dir_5d/15d values (out of {0,1}) must not reach training —
        # correct labels are the sign of target_ret_5d/15d, which here disagree with these.
        data["target_ret_5d"]  = [-1.0, 1.0] * (n // 2) + [-1.0] * (n % 2)
        data["target_ret_15d"] = [1.0, -1.0] * (n // 2) + [1.0] * (n % 2)
        fake_df = pd.DataFrame(data)

        with patch.object(mod, "read_df", return_value=fake_df):
            X, y5, y15, yr5, dates = mod.load_symbol_sequences("FAKESYM")

        assert set(np.unique(y5)).issubset({0, 1}), f"y5 out of {{0,1}}: {np.unique(y5)}"
        assert set(np.unique(y15)).issubset({0, 1}), f"y15 out of {{0,1}}: {np.unique(y15)}"
        # Labels must match the sign of the return columns, not any stale dir column.
        assert list(y5) == [1 if r > 0 else 0 for r in yr5]


class TestFeatureClipping:
    """2026-08-06: nan_to_num only maps true NaN/+-inf to 0 -- an extreme-but-finite outlier
    (confirmed live: dist_sma200_pct in [-3644, +2771], ret_1d/ret_5d reaching +-1.5M/+-3.2M)
    passes through untouched and can still blow up the first matmul. Both load_symbol_sequences
    (training) and load_inference_sequence (inference) must clip to +-FEATURE_CLIP_BOUND so
    training and serving see an identically-bounded feature distribution."""

    def _fake_df(self, n, overrides=None):
        import pandas as pd
        import src.server.dl_engine as mod

        feat_cols = mod.FEATURE_COLS[:mod.N_FEATURES]
        numeric_cols = [c for c in feat_cols if c not in mod._VOL_ONEHOT]
        data = {c: np.random.randn(n) * 0.5 for c in numeric_cols}
        data["date"] = pd.date_range("2024-01-01", periods=n).strftime("%Y-%m-%d")
        data["vol_regime"] = ["MED"] * n
        data["target_ret_5d"] = np.random.choice([-1.0, 1.0], n)
        data["target_ret_15d"] = np.random.choice([-1.0, 1.0], n)
        if overrides:
            for col, vals in overrides.items():
                data[col] = vals
        return pd.DataFrame(data)

    def test_load_symbol_sequences_clips_extreme_finite_outlier(self):
        import src.server.dl_engine as mod

        n = mod.SEQUENCE_LEN + 5
        # a single corrupted row mirroring the live-confirmed dist_sma200_pct outlier scale
        overrides = {"dist_sma200_pct": [0.0] * (n - 1) + [3_644_000.0]}
        fake_df = self._fake_df(n, overrides)

        with patch.object(mod, "read_df", return_value=fake_df):
            X, y5, y15, yr5, dates = mod.load_symbol_sequences("FAKESYM")

        assert np.isfinite(X).all(), "clipped output must remain finite"
        assert np.abs(X).max() <= mod.FEATURE_CLIP_BOUND, (
            f"a feature value of {np.abs(X).max()} exceeded FEATURE_CLIP_BOUND="
            f"{mod.FEATURE_CLIP_BOUND} -- the extreme outlier was not clipped"
        )

    def test_load_symbol_sequences_leaves_ordinary_values_untouched(self):
        """Negative control: clipping must not distort values already well within bound."""
        import src.server.dl_engine as mod

        n = mod.SEQUENCE_LEN + 5
        overrides = {"rsi_14": [42.5] * n}
        fake_df = self._fake_df(n, overrides)

        with patch.object(mod, "read_df", return_value=fake_df):
            X, *_ = mod.load_symbol_sequences("FAKESYM")

        feat_cols = mod.FEATURE_COLS[:mod.N_FEATURES]
        rsi_idx = feat_cols.index("rsi_14")
        assert np.allclose(X[:, :, rsi_idx], 42.5), (
            "an ordinary in-range value must pass through clipping unchanged"
        )

    def test_load_inference_sequence_uses_the_same_bound_as_training(self):
        """Train/serve skew guard: inference must clip identically to training, or the model
        sees a differently-shaped feature distribution live than it was trained on."""
        import src.server.dl_engine as mod

        n = mod.SEQUENCE_LEN
        overrides = {"op_margins": [0.0] * (n - 1) + [-19_479_000.0]}
        fake_df = self._fake_df(n, overrides)

        with patch.object(mod, "read_df", return_value=fake_df):
            X, latest_date = mod.load_inference_sequence("FAKESYM")

        assert X is not None
        assert np.isfinite(X).all()
        assert np.abs(X).max() <= mod.FEATURE_CLIP_BOUND


class TestWalkForwardValidation:
    def test_train_lstm_calls_walk_forward_validate(self):
        """train_lstm must call walk_forward_validate (not return a hardcoded NaN stub)."""
        import src.server.dl_engine as mod

        fake_seqs = np.random.randn(400, 60, N_FEATURES).astype(np.float32)
        fake_y5   = np.random.randint(0, 2, 400).astype(np.int64)
        fake_y15  = np.random.randint(0, 2, 400).astype(np.int64)
        fake_yr5  = np.random.randn(400).astype(np.float32)

        def fake_load(sym, seq_len=60):
            return fake_seqs, fake_y5, fake_y15, fake_yr5, ["2024-01-01"] * 400

        sentinel = {"directional_accuracy": 0.55, "roc_auc": 0.58, "n_folds": 3}

        with patch.object(mod, "load_symbol_sequences", side_effect=fake_load), \
             patch.object(mod, "connect") as mock_connect, \
             patch.object(mod, "walk_forward_validate", return_value=sentinel) as mock_wfv, \
             patch.object(mod, "_train_one_fold"), \
             patch("pathlib.Path.mkdir"), \
             patch("torch.save"):

            mock_conn = MagicMock()
            mock_conn.execute.return_value.fetchall.return_value = [("SYM1",), ("SYM2",)]
            mock_connect.return_value = mock_conn

            result = mod.train_lstm(version=99)

        mock_wfv.assert_called_once(), "walk_forward_validate was never called by train_lstm"
        assert result == sentinel, (
            f"train_lstm should return walk_forward_validate result, got {result}"
        )


class TestResolvePredictionDateUsesLogicalTradingDate:
    """2026-08-06: run_inference() defaulted prediction_date via datetime.today() -- but
    dl-infer-daily's cron fires at 18:30 UTC = 00:00 IST exactly, so every scheduled run
    (never passes --date) stamped deep_learning_predictions.prediction_date one calendar day
    ahead of the feature_store row it actually read. Must default via logical_trading_date()."""

    def test_no_arg_uses_logical_trading_date(self):
        with patch.object(dl_engine, "logical_trading_date", return_value="2026-07-31"):
            assert _resolve_prediction_date(None) == "2026-07-31", (
                "run_inference()'s default must come from logical_trading_date(), "
                "not a raw wall-clock date.today()/datetime.today() call"
            )

    def test_explicit_date_overrides_the_default(self):
        with patch.object(dl_engine, "logical_trading_date", return_value="2099-01-01"):
            assert _resolve_prediction_date("2026-06-25") == "2026-06-25", (
                "an explicit --date argument must never be overridden by logical_trading_date()"
            )

    def test_run_inference_calls_the_resolver_when_no_date_given(self):
        """Wiring check: run_inference() must actually route through _resolve_prediction_date
        (not silently reintroduce its own datetime.today() call) before it can fail loudly on
        a missing model file -- proves the fix is wired into the real entry point, not just
        that the helper function itself is correct in isolation."""
        with patch.object(dl_engine, "_resolve_prediction_date", return_value="2026-07-31") as mock_resolve, \
             patch.object(dl_engine, "_load_config", return_value={"lstm_version": 999999}):
            with pytest.raises(RuntimeError, match="No model at"):
                dl_engine.run_inference()
        mock_resolve.assert_called_once_with(None)
