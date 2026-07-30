"""Regression tests for Finding #16 (2026-07-28 full-stack audit): confluence_ml_engine.py
scored cv_roc_auc with StratifiedKFold(shuffle=True) over a query result with no
ORDER BY, on rows carrying 7-day-forward-return labels whose windows heavily overlap
across adjacent trading days -- a textbook CV leakage pattern for this codebase's own
already-established standard (ml_ensemble.py's TimeSeriesSplit(gap=embargo) purged
walk-forward CV). Fixed by sorting training rows by signal_date and switching to
TimeSeriesSplit with the same embargo formula ml_ensemble.py's _fit_stack uses.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import confluence_ml_engine as cme


class _FakeConn:
    """Rows are returned in the given (possibly out-of-order) order, mimicking a real
    connection with no ORDER BY -- exercises build_training_data()'s own sort step."""

    def __init__(self, rows):
        self._rows = rows

    def execute(self, sql):
        return self

    def fetchall(self):
        return self._rows


def _row(symbol, signal_date, outcome, confluence_score=50):
    return {
        "symbol": symbol,
        "signal_date": signal_date,
        "bullish_screener_count": 1, "bearish_screener_count": 0,
        "active_screener_count": 1, "trend_alignment_score": 1,
        "volume_score": 1, "sector_strength_score": 1, "fundamental_score": 1,
        "rsi": 55, "volume_ratio": 1.1, "above_sma200": 1, "signal_score": 1,
        "momentum_score": 60, "rank_composite": 60, "return_on_equity": 15,
        "piotroski_f_score": 6, "confluence_score": confluence_score,
        "outcome": outcome,
    }


class TestComputeEmbargo:
    def test_embargo_scales_with_horizon_and_row_density(self):
        # 100 rows across 10 unique dates -> 10 rows/day; horizon=7 -> raw embargo ~70,
        # capped at min(70, 100//6=16, 100//10=10) = 10
        embargo, n_splits = cme.compute_embargo(n_samples=100, n_unique_dates=10, horizon_days=7)
        assert embargo == 10
        assert n_splits >= 2

    def test_n_splits_never_below_two(self):
        embargo, n_splits = cme.compute_embargo(n_samples=30, n_unique_dates=3, horizon_days=7)
        assert n_splits >= 2

    def test_single_date_still_produces_a_finite_embargo(self):
        embargo, n_splits = cme.compute_embargo(n_samples=50, n_unique_dates=1, horizon_days=7)
        assert embargo >= 0
        assert n_splits >= 2


class TestBuildTrainingDataOrdering:
    def test_rows_are_sorted_chronologically_by_signal_date(self, monkeypatch):
        monkeypatch.setattr(cme, "MIN_TRAINING_ROWS", 2)
        rows = [
            _row("A", "2026-03-15", "WIN"),
            _row("B", "2026-01-10", "LOSS"),
            _row("C", "2026-02-20", "WIN"),
        ]
        conn = _FakeConn(rows)
        X, y, dates, n = cme.build_training_data(conn)
        assert n == 3
        assert list(dates) == ["2026-01-10", "2026-02-20", "2026-03-15"], \
            "build_training_data must sort by signal_date -- required for TimeSeriesSplit to be a real walk-forward split"

    def test_X_and_y_stay_aligned_with_dates_after_sort(self, monkeypatch):
        monkeypatch.setattr(cme, "MIN_TRAINING_ROWS", 2)
        rows = [
            _row("LATE", "2026-03-15", "LOSS", confluence_score=10),
            _row("EARLY", "2026-01-10", "WIN", confluence_score=90),
        ]
        conn = _FakeConn(rows)
        X, y, dates, n = cme.build_training_data(conn)
        # after sort, EARLY (WIN, score=90) must be first
        assert dates[0] == "2026-01-10"
        assert y[0] == 1  # WIN
        assert X[0][-1] == 90  # confluence_score is the last feature column

    def test_below_min_rows_returns_none_dates_too(self, monkeypatch):
        monkeypatch.setattr(cme, "MIN_TRAINING_ROWS", 5)
        conn = _FakeConn([_row("A", "2026-01-01", "WIN")])
        X, y, dates, n = cme.build_training_data(conn)
        assert X is None and y is None and dates is None
        assert n == 1


class TestTrainUsesTimeSeriesSplit:
    def test_train_uses_a_timeseriessplit_object_as_its_cv(self):
        import inspect
        src = inspect.getsource(cme.train)
        assert "cv = TimeSeriesSplit(" in src

    def test_stratifiedkfold_is_not_imported_at_module_level(self):
        assert not hasattr(cme, "StratifiedKFold"), \
            "StratifiedKFold(shuffle=True) on overlapping-horizon labels was the leak -- must not be importable again"
        assert hasattr(cme, "TimeSeriesSplit")


class _FakeRegistryConn:
    """Fake DB connection for train()'s promotion-gate integration test: answers the
    baseline SELECT, and records UPDATE/INSERT statements without touching a real DB."""

    def __init__(self, baseline_auc):
        self._baseline_auc = baseline_auc
        self.executed = []
        self.committed = 0
        self.rolled_back = 0

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if "SELECT cv_roc_auc" in sql:
            return self
        return self

    def fetchone(self):
        if self._baseline_auc is None:
            return None
        return (self._baseline_auc,)

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1


def _synthetic_training_set(n=80, n_dates=8, seed=0):
    """Deterministic, class-balanced, chronologically-sorted synthetic dataset shaped
    like build_training_data()'s real output -- lets train()'s promotion-gate logic be
    exercised end-to-end (real sklearn fit) without a live DB."""
    rng = np.random.default_rng(seed)
    X = rng.uniform(0, 100, size=(n, len(cme.FEATURE_COLS))).astype(np.float32)
    y = (np.arange(n) % 2).astype(int)  # perfectly balanced
    dates = np.array(sorted(
        f"2026-01-{(i % n_dates) + 1:02d}" for i in range(n)
    ))
    return X, y, dates, n


class TestPromotionGate:
    """Regression tests for Finding #17 (2026-07-28 full-stack audit): train() used to
    unconditionally overwrite confluence_ml.pkl and insert is_active=1 into model_registry
    regardless of the new model's AUC -- a single noisy retrain could silently degrade the
    live ml_breakout_probability with no safety net. Fixed with a champion/challenger gate
    matching ml_ensemble.py/live_screener_ml_ranker.py: only promote if the new CV AUC beats
    the active model's by >= PROMOTION_MARGIN, or there is no active model yet."""

    def test_no_baseline_always_promotes(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cme, "build_training_data", lambda conn: _synthetic_training_set())
        monkeypatch.setattr(cme, "MODEL_DIR", str(tmp_path))
        monkeypatch.setattr(cme, "MODEL_PATH", str(tmp_path / "confluence_ml.pkl"))
        monkeypatch.setattr(cme, "CANDIDATE_PATH", str(tmp_path / "confluence_ml.pkl.candidate"))

        conn = _FakeRegistryConn(baseline_auc=None)
        ok = cme.train(conn)

        assert ok is True
        assert os.path.exists(cme.MODEL_PATH), "no active baseline -> must always promote and write the live model file"
        insert_calls = [c for c in conn.executed if "INSERT INTO model_registry" in c[0]]
        assert len(insert_calls) == 1
        assert "VALUES (?, ?, ?, ?, ?, 1," in insert_calls[0][0], "is_active must be 1 when promoted"

    def test_regression_beyond_margin_is_rejected(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cme, "build_training_data", lambda conn: _synthetic_training_set())
        monkeypatch.setattr(cme, "MODEL_DIR", str(tmp_path))
        monkeypatch.setattr(cme, "MODEL_PATH", str(tmp_path / "confluence_ml.pkl"))
        monkeypatch.setattr(cme, "CANDIDATE_PATH", str(tmp_path / "confluence_ml.pkl.candidate"))

        # Baseline set impossibly high (0.999) so the new model can never clear it --
        # deterministic rejection regardless of what the synthetic model actually scores.
        conn = _FakeRegistryConn(baseline_auc=0.999)
        ok = cme.train(conn)

        assert ok is True  # train() itself doesn't fail -- it just declines to promote
        assert not os.path.exists(cme.MODEL_PATH), "rejected candidate must NOT overwrite the live model file"
        assert os.path.exists(cme.CANDIDATE_PATH), "rejected candidate must be saved for inspection"
        insert_calls = [c for c in conn.executed if "INSERT INTO model_registry" in c[0]]
        assert len(insert_calls) == 1
        assert "VALUES (?, ?, ?, ?, ?, 0," in insert_calls[0][0], "is_active must be 0 for a rejected candidate"
        update_calls = [c for c in conn.executed if "UPDATE model_registry SET is_active = 0" in c[0]]
        assert update_calls == [], "a rejected candidate must not deactivate the current live model"
