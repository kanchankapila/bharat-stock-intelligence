"""walk_forward_validate must split the validation panel by DATE, not by row position.

Found 2026-09-10. `train_lstm` builds its validation panel by concatenating whole per-symbol
arrays (`load_sequences_bounded` yields "in completion order"), then handed that array to
`walk_forward_validate`, which sliced it with `X[:train_end]` / `X[val_end:test_end]` -- row
positions, on a symbol-major panel. So each "fold" trained on the full history of ~40 stocks
and tested on the full history of ~3 OTHER stocks over the SAME calendar dates.

Measured against production `feature_store` before the fix (50 symbols, 59,702 sequences,
the function's own min_train=300 / fold_size=2000 arithmetic):

    fold 0: train rows[:300]   test rows[2300:4300]   test dates also in train:  22.1%
    fold 1: train rows[:2300]  test rows[4300:6300]   test dates also in train:  99.9%
    fold 2+: ................................................................. 100.0%
    (28 folds; train and test both span 2021-03-31..2026-09-09; shared symbols = 0)

Daily equity direction is dominated by a market-wide common factor, so seeing a date's move
in 40 other names makes that date's move in 3 held-out names far easier to call than a genuine
forward prediction. Every roc_auc in `dl_model_config.json` -- the number `_promote_lstm_version`
gates on -- was produced this way, which is why the DL engine reported 0.6459-0.6578 while every
other engine on this platform ceilings at 0.52-0.55 (measurement.md).

`purged_cv.py` already existed for exactly this, and its own docstring names the hazard ("A
row-count gap can split a trading day in half; this splitter always treats the date as the unit
of time"). ml_ensemble.py, breakout_classifier.py and flyer_classifier.py all use it; dl_engine.py
was the one model that did not.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

torch = pytest.importorskip("torch")

import dl_engine as dl


def _symbol_major_panel(n_symbols: int = 6, n_dates: int = 60):
    """The exact shape train_lstm builds: every date of symbol 0, then every date of symbol 1...

    Row position therefore carries NO time information, which is what made the old row-index
    slicing wrong. Returns (dates, symbols) parallel to the concatenated sequence array.
    """
    all_dates = [f"2026-{1 + (d // 28):02d}-{1 + (d % 28):02d}" for d in range(n_dates)]
    dates, symbols = [], []
    for s in range(n_symbols):
        for d in all_dates:
            dates.append(d)
            symbols.append(f"SYM{s}")
    return dates, symbols


class TestDateFolds:
    def test_every_fold_trains_strictly_before_it_tests(self):
        dates, _ = _symbol_major_panel()
        folds = dl._date_folds(dates, horizon_days=5, n_splits=3)

        assert folds, "no folds produced"
        for i, (train_idx, test_idx) in enumerate(folds):
            latest_train = max(dates[j] for j in train_idx)
            earliest_test = min(dates[j] for j in test_idx)
            assert latest_train < earliest_test, (
                f"fold {i}: trains on {latest_train} but tests on {earliest_test} -- "
                f"the training slice reaches into (or past) the test period"
            )

    def test_no_test_date_ever_appears_in_the_training_slice(self):
        """The direct regression assertion. Row slicing scored 100% overlap here."""
        dates, _ = _symbol_major_panel()
        folds = dl._date_folds(dates, horizon_days=5, n_splits=3)

        for i, (train_idx, test_idx) in enumerate(folds):
            train_dates = {dates[j] for j in train_idx}
            test_dates = {dates[j] for j in test_idx}
            overlap = train_dates & test_dates
            assert not overlap, (
                f"fold {i}: {len(overlap)} of {len(test_dates)} test dates are also in the "
                f"training slice -- this is a cross-sectional split, not a walk-forward"
            )

    def test_folds_purge_at_least_the_label_horizon(self):
        """A 15-day forward label at date D resolves at D+15, so training must stop >=15
        trading dates before the test fold opens or the labels themselves overlap."""
        dates, _ = _symbol_major_panel()
        ordered = sorted(set(dates))
        horizon = 15
        folds = dl._date_folds(dates, horizon_days=horizon, n_splits=3)

        for i, (train_idx, test_idx) in enumerate(folds):
            latest_train = max(dates[j] for j in train_idx)
            earliest_test = min(dates[j] for j in test_idx)
            gap = ordered.index(earliest_test) - ordered.index(latest_train) - 1
            assert gap >= horizon, (
                f"fold {i}: only {gap} dates purged between train and test, need {horizon}"
            )

    def test_a_fold_keeps_every_symbol_present_on_its_dates(self):
        """A date split must be cross-sectionally complete: taking a date means taking all of
        that date's symbols. The old split did the opposite -- it took whole symbols."""
        dates, symbols = _symbol_major_panel()
        folds = dl._date_folds(dates, horizon_days=5, n_splits=3)

        train_idx, test_idx = folds[0]
        assert {symbols[j] for j in test_idx} == set(symbols), (
            "the test fold must contain every symbol, not a symbol subset"
        )
        assert {symbols[j] for j in train_idx} == set(symbols)


class TestWalkForwardValidateUsesDates:
    def _stub_training(self, monkeypatch):
        """Record which rows each fold trains and tests on, without running torch.

        X encodes each row's date ordinal at [:, 0, 0], so the captured arrays are enough to
        reconstruct the fold's date span from real production code paths.
        """
        seen = {"train": [], "test": []}

        def fake_train_one_fold(model, X, y5, yr5, epochs=30, y15=None, scaler=None):
            seen["train"].append(X[:, 0, 0].copy())

        def fake_predict_batch(model, X, bs=256):
            seen["test"].append(X[:, 0, 0].copy())
            n = len(X)
            prob = np.linspace(0.2, 0.8, n).astype(np.float32)
            return {"dir_5d": np.column_stack([1.0 - prob, prob])}

        monkeypatch.setattr(dl, "_train_one_fold", fake_train_one_fold)
        monkeypatch.setattr(dl, "_predict_batch", fake_predict_batch)
        return seen

    def _panel(self):
        dates, _ = _symbol_major_panel(n_symbols=6, n_dates=60)
        ordinal = {d: i for i, d in enumerate(sorted(set(dates)))}
        n = len(dates)
        X = np.zeros((n, 2, 3), dtype=np.float32)
        X[:, 0, 0] = [ordinal[d] for d in dates]
        rng = np.random.default_rng(0)
        y5 = rng.integers(0, 2, n).astype(np.int64)
        y15 = rng.integers(0, 2, n).astype(np.int64)
        yr5 = rng.standard_normal(n).astype(np.float32)
        return dates, X, y5, y15, yr5

    def test_folds_are_time_separated_end_to_end(self, monkeypatch):
        seen = self._stub_training(monkeypatch)
        dates, X, y5, y15, yr5 = self._panel()
        model = dl.BiLSTMModel(n_features=3)

        dl.walk_forward_validate(model, X, y5, y15, yr5, dates,
                                 horizon_days=5, n_splits=3)

        assert seen["train"], "no fold ever trained"
        assert len(seen["train"]) == len(seen["test"])
        for i, (tr, te) in enumerate(zip(seen["train"], seen["test"])):
            assert tr.max() < te.min(), (
                f"fold {i}: trained through date ordinal {tr.max():.0f} but tested from "
                f"{te.min():.0f} -- rows are still being split by position, not by date"
            )

    def test_rejects_a_dates_vector_that_does_not_match_the_panel(self):
        dates, X, y5, y15, yr5 = self._panel()
        model = dl.BiLSTMModel(n_features=3)

        with pytest.raises(ValueError, match="dates"):
            dl.walk_forward_validate(model, X, y5, y15, yr5, dates[:-1],
                                     horizon_days=5, n_splits=3)

    def test_returns_nan_metrics_rather_than_raising_on_too_few_dates(self, monkeypatch):
        """One date cannot be split. The gate reads NaN as 'cannot confirm safe to promote',
        which is the correct refusal -- but it must not take the training run down with it."""
        self._stub_training(monkeypatch)
        n = 40
        X = np.zeros((n, 2, 3), dtype=np.float32)
        y5 = np.zeros(n, dtype=np.int64)
        y15 = np.zeros(n, dtype=np.int64)
        yr5 = np.zeros(n, dtype=np.float32)
        model = dl.BiLSTMModel(n_features=3)

        metrics = dl.walk_forward_validate(model, X, y5, y15, yr5, ["2026-01-02"] * n,
                                           horizon_days=5, n_splits=3)

        assert np.isnan(metrics["roc_auc"])
        assert metrics["n_folds"] == 0


class TestTrainLstmSuppliesDates:
    """train_lstm owns the panel, so it is the only place the dates can come from.

    It also has to ask for the same feature WIDTH on both loads. `_load` passes
    n_features=N_FEATURES explicitly (its comment explains why); `_load_val` did not, so it
    fell through to `_resolve_input_width(None)` -> `_INFERENCE_INPUT_WIDTH`, a module global
    that `run_inference` sets to the ACTIVE champion's width. lstm_v3, the champion, is a
    pre-widening 78-input checkpoint. python_api.py and backend-python/main.py both expose
    /api/train-dl and /api/infer-dl from a single process with dl_engine module-level
    imported, so an infer-then-train sequence there feeds 78-wide validation rows to an
    85-wide model -- a size mismatch swallowed by the caller's broad except, leaving NaN
    metrics and a gate that cannot promote anything.
    """

    def _run_train_lstm(self, monkeypatch, n_rows=400):
        from unittest.mock import MagicMock

        captured = {"widths": [], "wfv": None}
        dates = [f"2026-{1 + (i // 28):02d}-{1 + (i % 28):02d}" for i in range(n_rows)]

        def fake_load(sym, seq_len=60, n_features=None):
            captured["widths"].append(n_features)
            return (
                np.zeros((n_rows, 2, 3), dtype=np.float32),
                np.zeros(n_rows, dtype=np.int64),
                np.zeros(n_rows, dtype=np.int64),
                np.zeros(n_rows, dtype=np.float32),
                list(dates),
            )

        def fake_wfv(model, X, y5, y15, yr5, panel_dates, **kwargs):
            captured["wfv"] = {"n_rows": len(X), "n_dates": len(panel_dates)}
            return {"roc_auc": 0.5, "directional_accuracy": 0.5, "n_folds": 3}

        mock_conn = MagicMock()
        mock_conn.execute.return_value.fetchall.return_value = [("SYM1",), ("SYM2",)]

        monkeypatch.setattr(dl, "load_symbol_sequences", fake_load)
        monkeypatch.setattr(dl, "walk_forward_validate", fake_wfv)
        monkeypatch.setattr(dl, "connect", lambda *a, **k: mock_conn)
        monkeypatch.setattr(dl, "_train_one_fold", lambda *a, **k: None)
        monkeypatch.setattr(torch, "save", lambda *a, **k: None)

        dl.train_lstm(version=99)
        return captured

    def test_walk_forward_gets_one_date_per_sequence(self, monkeypatch):
        captured = self._run_train_lstm(monkeypatch)

        assert captured["wfv"] is not None, "walk_forward_validate was never called"
        assert captured["wfv"]["n_dates"] == captured["wfv"]["n_rows"], (
            "every validation sequence must carry the date it was taken on"
        )

    def test_both_loaders_request_the_current_feature_width(self, monkeypatch):
        captured = self._run_train_lstm(monkeypatch)

        assert captured["widths"], "load_symbol_sequences was never called"
        assert all(w == dl.N_FEATURES for w in captured["widths"]), (
            f"every load must pin the width to N_FEATURES={dl.N_FEATURES}; got "
            f"{sorted(set(captured['widths']), key=str)} -- a None falls through to the "
            f"active champion's width and silently skews validation against training"
        )


class TestFoldsStartFromFreshWeights:
    """A date split is not enough on its own: the model handed in was fit on the WHOLE
    universe, test dates included, and each fold cloned its weights before fine-tuning. So
    every fold started from a network that had already seen the period it was about to be
    graded on -- the second half of AF-20260906-02.

    A walk-forward number is meant to answer "how does a model trained only on the past do on
    the future", so the fold must start where a real forward-in-time fit would: from scratch,
    at the source model's width.
    """
    SENTINEL = 0.25

    def _panel(self):
        dates, _ = _symbol_major_panel(n_symbols=6, n_dates=60)
        n = len(dates)
        X = np.zeros((n, 2, 3), dtype=np.float32)
        rng = np.random.default_rng(1)
        return (dates, X,
                rng.integers(0, 2, n).astype(np.int64),
                rng.integers(0, 2, n).astype(np.int64),
                rng.standard_normal(n).astype(np.float32))

    def _seeded_model(self):
        model = dl.BiLSTMModel(n_features=3)
        with torch.no_grad():
            model.lstm1.weight_ih_l0.fill_(self.SENTINEL)
        return model

    def _capture(self, monkeypatch):
        starts = []

        def fake_train_one_fold(model, X, y5, yr5, epochs=30, y15=None, scaler=None):
            w = model.lstm1.weight_ih_l0.detach().cpu().flatten()
            starts.append({"first": float(w[0]), "width": model.lstm1.weight_ih_l0.shape[1]})

        def fake_predict_batch(model, X, bs=256):
            prob = np.linspace(0.2, 0.8, len(X)).astype(np.float32)
            return {"dir_5d": np.column_stack([1.0 - prob, prob])}

        monkeypatch.setattr(dl, "_train_one_fold", fake_train_one_fold)
        monkeypatch.setattr(dl, "_predict_batch", fake_predict_batch)
        return starts

    def test_each_fold_starts_from_scratch_by_default(self, monkeypatch):
        starts = self._capture(monkeypatch)
        dates, X, y5, y15, yr5 = self._panel()

        dl.walk_forward_validate(self._seeded_model(), X, y5, y15, yr5, dates,
                                 horizon_days=5, n_splits=3)

        assert starts, "no fold ever trained"
        assert all(s["first"] != pytest.approx(self.SENTINEL) for s in starts), (
            "a fold inherited the weights of a model that was trained on its own test dates"
        )

    def test_a_fresh_fold_still_matches_the_source_width(self, monkeypatch):
        starts = self._capture(monkeypatch)
        dates, X, y5, y15, yr5 = self._panel()

        dl.walk_forward_validate(self._seeded_model(), X, y5, y15, yr5, dates,
                                 horizon_days=5, n_splits=3)

        assert all(s["width"] == 3 for s in starts), (
            "fresh folds must be built at the SOURCE model's width, not today's N_FEATURES "
            "-- a legacy 78-input champion would otherwise crash the whole validation"
        )

    def test_the_seeded_arm_is_still_reachable_for_measurement(self, monkeypatch):
        """scripts/measure_dl_walkforward_leak.py exists to size this exact effect; it needs
        both arms, so the leaky one stays available behind an explicit flag."""
        starts = self._capture(monkeypatch)
        dates, X, y5, y15, yr5 = self._panel()

        dl.walk_forward_validate(self._seeded_model(), X, y5, y15, yr5, dates,
                                 horizon_days=5, n_splits=3, seed_from_model=True)

        assert all(s["first"] == pytest.approx(self.SENTINEL) for s in starts)


def test_date_folds_refuses_a_fold_whose_test_dates_leak_into_training(monkeypatch):
    """The durable guard, not another paragraph in a rules file.

    recurring-bugs.md's own header says prose does not hold -- the counts there were all
    recorded AFTER the class was written down. This asserts the invariant at runtime, so a
    future change to how folds are built (a different splitter, a tweak to purged_cv, a
    "quick" inline split) cannot silently reintroduce the overlap regardless of HOW it is
    computed. It costs one set intersection per fold.
    """
    import purged_cv

    class _OverlappingSplitter:
        def split(self, X, y=None, groups=None):
            n = len(X)
            yield np.arange(0, n // 2), np.arange(n // 4, n)

    monkeypatch.setattr(purged_cv, "make_purged_group_time_series_split",
                        lambda *a, **k: _OverlappingSplitter())
    dates, _ = _symbol_major_panel()

    with pytest.raises(ValueError, match="BOTH its train and test"):
        dl._date_folds(dates)
