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


class TestExtractFeaturesSharedBetweenTrainAndScore:
    """FEATURE_SPEC/_extract_features is the single source of truth build_training_data()
    (fit-time) and update_probabilities() (score-time) both read -- a train/serve column-order
    mismatch here would silently feed the model the wrong feature in the wrong slot, the same
    failure class fixed in live_screener_ml_ranker.py/live_screener_optimizer.py (2026-08-07),
    just caught here before it could ever happen instead of after."""

    def test_extract_features_matches_declared_order_and_defaults(self):
        row = _row("INFY", "2026-08-01", "WIN", confluence_score=77)
        out = cme._extract_features(row)
        assert out == [row[col] for col, _ in cme.FEATURE_SPEC]
        assert out[-1] == 77   # confluence_score stays last, matching both original inline lists

    def test_falsy_values_fall_back_to_declared_default(self):
        row = _row("INFY", "2026-08-01", "WIN")
        row["rsi"] = 0            # falsy but a real, meaningful RSI-of-zero would be unusual
        row["above_sma200"] = None
        out = cme._extract_features(row)
        rsi_idx = [c for c, _ in cme.FEATURE_SPEC].index("rsi")
        assert out[rsi_idx] == 50   # falls back to FEATURE_SPEC's declared default

    def test_build_training_data_and_update_probabilities_read_the_same_spec(self):
        # Both functions must reference the module-level _extract_features -- grepping the
        # source is the only way to catch a future re-duplication of the inline list, since
        # a unit test on correct behavior can't detect "someone pasted it back in".
        import inspect
        train_src = inspect.getsource(cme.build_training_data)
        score_src = inspect.getsource(cme.update_probabilities)
        assert "_extract_features(" in train_src
        assert "_extract_features(" in score_src


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

    def __init__(self, baseline_auc, baseline_id=1, baseline_trained_at="2026-01-01T00:00:00",
                 rejections=0):
        self._baseline_auc = baseline_auc
        self._baseline_id = baseline_id
        self._baseline_trained_at = baseline_trained_at
        # 0 by default (below CONFLUENCE_STALENESS_MAX_REJECTIONS=10) so the staleness-override
        # safety valve (2026-08-06) can never spuriously fire in the basic promotion-gate tests
        # below regardless of how old/new _baseline_trained_at computes against real wall-clock
        # time -- staleness_override_applies requires BOTH age AND rejection-count thresholds.
        self._rejections = rejections
        self.executed = []
        self.committed = 0
        self.rolled_back = 0
        self._last_sql = None

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        self._last_sql = sql
        return self

    def fetchone(self):
        sql = self._last_sql or ""
        if "SELECT id, cv_roc_auc, trained_at" in sql:
            return None if self._baseline_auc is None else (
                self._baseline_id, self._baseline_auc, self._baseline_trained_at)
        if "SELECT COUNT(*) FROM model_registry" in sql:
            return (self._rejections,)
        return None

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


class TestConfluenceMlStalenessOverride:
    """2026-08-06: confluence_ml had no staleness-override safety valve at all -- confirmed
    live, its real active baseline (trained 2026-07-30T10:11:57Z) predates the 2026-07-30
    CV-leakage fix (commit aa5862d2, ~46min later) and carries a leak-inflated AUC (0.777) that
    every honest post-fix retrain since has been rejected against. Wired to
    model_promotion.staleness_override_applies, mirroring ml_ensemble.py/cs_ranker.py."""

    def test_stale_unbeaten_baseline_with_enough_rejections_is_overridden(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cme, "build_training_data", lambda conn: _synthetic_training_set())
        monkeypatch.setattr(cme, "MODEL_DIR", str(tmp_path))
        monkeypatch.setattr(cme, "MODEL_PATH", str(tmp_path / "confluence_ml.pkl"))
        monkeypatch.setattr(cme, "CANDIDATE_PATH", str(tmp_path / "confluence_ml.pkl.candidate"))
        monkeypatch.setattr(
            cme, "staleness_override_applies",
            lambda trained_at, rejections, max_days, max_rejections: (True, 42.0))

        conn = _FakeRegistryConn(baseline_auc=0.999, rejections=cme.CONFLUENCE_STALENESS_MAX_REJECTIONS)
        ok = cme.train(conn)

        assert ok is True
        assert os.path.exists(cme.MODEL_PATH), (
            "a candidate stuck behind a stale, permanently-unbeatable baseline must still be "
            "auto-adopted once the staleness override fires"
        )
        insert_calls = [c for c in conn.executed if "INSERT INTO model_registry" in c[0]]
        assert "STALENESS OVERRIDE" in insert_calls[0][1][-1], (
            "the promoted row's notes must record that this was a staleness override, not a "
            "genuine margin-clearing promotion, for future audit"
        )

    def test_young_baseline_with_many_rejections_is_not_overridden(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cme, "build_training_data", lambda conn: _synthetic_training_set())
        monkeypatch.setattr(cme, "MODEL_DIR", str(tmp_path))
        monkeypatch.setattr(cme, "MODEL_PATH", str(tmp_path / "confluence_ml.pkl"))
        monkeypatch.setattr(cme, "CANDIDATE_PATH", str(tmp_path / "confluence_ml.pkl.candidate"))
        monkeypatch.setattr(
            cme, "staleness_override_applies",
            lambda trained_at, rejections, max_days, max_rejections: (False, 0.5))

        conn = _FakeRegistryConn(baseline_auc=0.999, rejections=cme.CONFLUENCE_STALENESS_MAX_REJECTIONS)
        cme.train(conn)

        assert not os.path.exists(cme.MODEL_PATH)
        assert os.path.exists(cme.CANDIDATE_PATH)

    def test_stale_baseline_with_few_rejections_is_not_overridden(self, monkeypatch, tmp_path):
        monkeypatch.setattr(cme, "build_training_data", lambda conn: _synthetic_training_set())
        monkeypatch.setattr(cme, "MODEL_DIR", str(tmp_path))
        monkeypatch.setattr(cme, "MODEL_PATH", str(tmp_path / "confluence_ml.pkl"))
        monkeypatch.setattr(cme, "CANDIDATE_PATH", str(tmp_path / "confluence_ml.pkl.candidate"))
        monkeypatch.setattr(
            cme, "staleness_override_applies",
            lambda trained_at, rejections, max_days, max_rejections: (False, 90.0))

        conn = _FakeRegistryConn(baseline_auc=0.999, rejections=1)
        cme.train(conn)

        assert not os.path.exists(cme.MODEL_PATH)
        assert os.path.exists(cme.CANDIDATE_PATH)
