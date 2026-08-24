import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import drift_detector as dd


class TestCheckFeatureDriftDateSampling:
    """Regression test found via live log review (2026-08-14): check_feature_drift's
    'recent' window was `df.iloc[-30:]` -- the last 30 ROWS, not the last 30 DAYS.
    feature_store is a (symbol, date) panel (~2,400 symbol-rows per date), so that
    sliced 30 symbols off a SINGLE date. Any market-wide column broadcast identically
    to every symbol on a date (fii_10d_net, dxy, nifty_vix, ...) then had near-zero
    variance in "recent" against a real multi-date baseline, which pins PSI far above
    PSI_CRIT every run regardless of actual drift -- confirmed live: max_psi ~12.4-12.9
    and crit_frac 76-87% -> EMERGENCY_RETRAIN on every single day 2026-08-01 through
    2026-08-14, never varying the way genuine drift would. This silently forced a
    permanent 0.85x haircut on every scored win_probability (see get_drift_multiplier /
    scoring_engine.py's _refresh_drift_multiplier)."""

    @staticmethod
    def _make_panel(n_dates=100, n_symbols=20, seed=0):
        rng = np.random.default_rng(seed)
        dates = pd.date_range("2026-01-01", periods=n_dates, freq="D").strftime("%Y-%m-%d")
        # A market-wide column: identical across symbols on a given date, drawn from the
        # SAME distribution for every date -- i.e. genuinely no drift.
        macro_by_date = dict(zip(dates, rng.normal(0, 1, n_dates)))
        rows = []
        for d in dates:
            for s in range(n_symbols):
                rows.append({"date": d, "symbol": f"SYM{s}", "timeframe": "D",
                             "fii_10d_net": macro_by_date[d]})
        return pd.DataFrame(rows)

    def test_recent_window_spans_multiple_dates_not_one(self, monkeypatch):
        df = self._make_panel()
        monkeypatch.setattr(dd, "read_df", lambda *a, **k: df)
        monkeypatch.setattr(dd, "execute", lambda *a, **k: None)

        result = dd.check_feature_drift()

        assert result["status"] != "EMERGENCY_RETRAIN", (
            "a market-wide column with NO real drift (same distribution every date) "
            "must not trigger EMERGENCY_RETRAIN -- if it does, 'recent' collapsed back "
            "to a single date"
        )

    def test_negative_control_old_row_slice_falsely_flags_this_exact_data(self):
        """Confirms the panel above is a real reproduction of the bug: the OLD
        `df.iloc[-30:]` logic must misclassify it as extreme drift, or this test
        isn't testing the bug that was actually found."""
        df = self._make_panel()
        numeric_cols = ["fii_10d_net"]
        cutoff_idx = int(len(df) * 0.8)
        baseline = df.iloc[:cutoff_idx]
        recent_old = df.iloc[-30:]  # the pre-fix slice

        b = baseline["fii_10d_net"].values
        r = recent_old["fii_10d_net"].values
        p = dd._psi(b, r)
        assert p > dd.PSI_CRIT, (
            "expected the old row-based slice to falsely read as critical drift "
            "on this no-real-drift panel -- if it doesn't, the repro is stale"
        )


class TestGetDriftMultiplier:
    """Regression test for Finding #83 (2026-07-28 full-stack audit, confirmed via
    direct signature inspection): get_drift_multiplier() called
    query_one(_conn, sql, params) with 3 positional arguments, but db_compat's
    query_one(sql, params=()) takes exactly 2 -- every call raised TypeError, silently
    swallowed by the surrounding `except Exception`, which returned the default 1.0
    (no haircut) and logged an indistinguishable "defaulting to 1.0" line. This safety
    mechanism (a confidence haircut on win_probability when the DL model's feature
    distribution or accuracy has drifted) had been permanently inert since it was
    written. The fix drops the erroneous extra argument and the now-pointless `conn`
    parameter (query_one always opens its own connection regardless)."""

    def test_calls_query_one_with_correct_arity(self, monkeypatch):
        """The original bug was an extra positional `conn` argument (query_one takes exactly
        (sql, params)). Asserts the ARITY invariant, not a call count -- get_drift_multiplier
        legitimately makes additional app_settings lookups for its thresholds, and pinning the
        count would fail on that unrelated change while catching no real defect."""
        calls = []

        def fake_query_one(sql, params=(), *extra):
            assert not extra, f"query_one called with extra positional args: {extra}"
            assert isinstance(sql, str), f"first arg must be the SQL string, got {type(sql)}"
            calls.append((sql, params))
            return {"drift_score": 0.10, "value": None}

        monkeypatch.setattr(dd, "query_one", fake_query_one)
        result = dd.get_drift_multiplier()
        assert calls, "must actually query for the drift score"
        assert any("dl_model_performance" in sql for sql, _ in calls)
        assert result == 1.0

    def test_no_drift_row_defaults_to_no_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: None)
        assert dd.get_drift_multiplier() == 1.0

    def test_warn_threshold_applies_moderate_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"drift_score": dd.DRIFT_AVG_WARN + 0.01})
        assert dd.get_drift_multiplier() == 0.93

    def test_critical_threshold_applies_full_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"drift_score": dd.DRIFT_AVG_CRIT + 0.01})
        assert dd.get_drift_multiplier() == 0.85

    def test_below_warn_threshold_no_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"drift_score": 0.05})
        assert dd.get_drift_multiplier() == 1.0

    def test_NEGATIVE_CONTROL_typical_no_drift_avg_psi_does_not_trigger_a_haircut(self, monkeypatch):
        """The defect that made this whole review necessary: `drift_score` is avg_psi, but it was
        compared against PSI_CRIT (a PER-FEATURE bar). avg_psi's measured null on this panel never
        fell below 0.647 across 16 historical evaluation points, so `ds > 0.25` was true on every
        run ever made -- a permanent, undecided 0.85x haircut on every stock's win_probability,
        which then fed hard thresholds (0.55/0.40/0.30) in scoring_engine.apply_ml_score_adjustment.
        Fails against the pre-fix code (which returns 0.85 here), passes once the multiplier
        thresholds avg_psi on its own scale."""
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"drift_score": 0.65})
        assert dd.get_drift_multiplier() == 1.0, (
            "a drift_score at the LOW end of this panel's own measured no-drift range must not "
            "apply a haircut -- if it does, the haircut is unconditional and carries no signal"
        )

    def test_a_genuinely_broken_query_still_degrades_gracefully_to_no_haircut(self, monkeypatch):
        """If query_one itself raises for an unrelated reason (DB down), the function
        must still return the safe default rather than propagating the exception --
        this is deliberate resilience, distinct from the arity bug being regression-
        tested above (which raised on every single call, not just failures)."""
        def always_raises(*a, **k):
            raise RuntimeError("DB unavailable")
        monkeypatch.setattr(dd, "query_one", always_raises)
        assert dd.get_drift_multiplier() == 1.0


class TestThresholdOverride:
    """Thresholds are app_settings-overridable defaults, not fixed constants -- so recalibration
    (which WILL be needed as feature_store grows and the feature set changes) is a settings
    update rather than a code change. Fail-open: a missing or garbage settings row must fall
    back to the measured default, never disable drift detection or raise inside a monitor."""

    def test_missing_setting_falls_back_to_default(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: None)
        assert dd._threshold("drift_psi_crit", 3.6) == 3.6

    def test_setting_overrides_default(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"value": "5.5"})
        assert dd._threshold("drift_psi_crit", 3.6) == 5.5

    def test_garbage_and_nonfinite_values_fall_back(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"value": "not-a-number"})
        assert dd._threshold("drift_psi_crit", 3.6) == 3.6
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"value": "nan"})
        assert dd._threshold("drift_psi_crit", 3.6) == 3.6

    def test_a_raising_query_does_not_break_the_monitor(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("DB down")
        monkeypatch.setattr(dd, "query_one", boom)
        assert dd._threshold("drift_psi_crit", 3.6) == 3.6

    def test_haircut_respects_an_overridden_threshold(self, monkeypatch):
        """End-to-end: an operator raising drift_avg_crit must actually change the haircut."""
        def fake(sql, params=()):
            if "app_settings" in sql:
                return {"value": "9.0"}          # crit bar raised well above the score
            return {"drift_score": 2.0}          # would be 0.85x under the default 1.5
        monkeypatch.setattr(dd, "query_one", fake)
        assert dd.get_drift_multiplier() == 1.0


class TestWriteTrainingMetrics:
    """Layer 3 plumbing (2026-08-24): walk_forward_validate() computed a held-out
    roc_auc on every training run but nothing ever wrote it to dl_model_performance,
    leaving the API's AUC history permanently NULL and check_accuracy_drift without
    a fresh baseline. These pin the write contract against regressions."""

    def test_persists_acc_and_auc_under_the_given_date_with_real_version(self, monkeypatch):
        captured = {}

        def fake_execute(sql, params):
            captured["sql"] = sql
            captured["params"] = params

        monkeypatch.setattr(dd, "execute", fake_execute)

        dd.write_training_metrics({"directional_accuracy": 0.61, "roc_auc": 0.583,
                                   "n_test": 900},
                                  eval_date="2026-08-24", model_version="lstm_v7")

        assert "INSERT INTO dl_model_performance" in captured["sql"]
        # The schema's ON CONFLICT target must be preserved verbatim -- a different
        # target would collide with the daily drift row or fail outright.
        assert "(model_name, eval_date, horizon_days)" in captured["sql"]
        # 6 bound params: model_name, model_version, eval_date, acc, auc, n.
        # horizon_days=5 is inline SQL, not a placeholder.
        name, version, day, acc, auc, n = captured["params"]
        assert (name, version, day) == ("LSTM_TFT_ENSEMBLE", "lstm_v7", "2026-08-24")
        assert (acc, auc, n) == (0.61, 0.583, 900)

    def test_nan_and_missing_metrics_become_null_not_zero(self, monkeypatch):
        # A failed validation run reports NaN -- persisting it as 0.0 would poison
        # ORDER BY ... LIMIT 1 monitors and any human reading the table.
        captured = {}
        monkeypatch.setattr(dd, "execute",
                            lambda sql, params: captured.update(params=params))

        dd.write_training_metrics({"directional_accuracy": float("nan"),
                                   "roc_auc": None}, eval_date="2026-08-24")

        _, _, _, acc, auc, n = captured["params"]
        assert acc is None and auc is None and n is None

    def test_db_failure_is_swallowed_so_training_is_never_failed_by_a_monitor_write(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("DB down")
        monkeypatch.setattr(dd, "execute", boom)
        dd.write_training_metrics({"roc_auc": 0.6})  # must not raise


class TestCheckAucDrift:
    """The monitor half of Layer 3: surface absolute serving-quality decay; never gate."""

    @staticmethod
    def _row(auc, day="2026-08-20"):
        return {"roc_auc": auc, "eval_date": day}

    def test_above_floor_is_ok(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: self._row(0.60))
        result = dd.check_auc_drift(min_roc_auc=0.55)
        assert result["status"] == "OK"
        assert result["held_out_roc_auc"] == 0.60

    def test_below_floor_reports_degraded_without_raising_or_exiting(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: self._row(0.51))
        result = dd.check_auc_drift(min_roc_auc=0.55)
        assert result["status"] == "DEGRADED"

    def test_no_persisted_data_yet_reads_no_data_not_degraded(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: None)
        assert dd.check_auc_drift(min_roc_auc=0.55)["status"] == "NO_DATA"

    def test_query_failure_degrades_gracefully_like_every_other_monitor_here(self, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("DB down")
        monkeypatch.setattr(dd, "query_one", boom)
        assert dd.check_auc_drift(min_roc_auc=0.55)["status"] == "QUERY_FAILED"

    def test_default_floor_consults_app_settings_via_threshold_helper(self, monkeypatch):
        called = {}
        base = {"roc_auc": 0.60, "eval_date": "2026-08-20"}

        def fake(key, default):
            called[key] = True
            return default

        monkeypatch.setattr(dd, "_threshold", fake)
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: dict(base))
        result = dd.check_auc_drift()

        assert called.get("dl_min_roc_auc"), (
            "floor must be settings-overridable like every other threshold in this module"
        )
        assert result["status"] == "OK"

    def test_even_a_collapsed_auc_cannot_emit_emergency_retrain(self, monkeypatch):
        # Guard the design decision: this is a monitor. If it ever grows an exit(1),
        # it starts fighting model_promotion's relative bars + staleness override.
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: self._row(0.01))
        assert dd.check_auc_drift()["status"] != "EMERGENCY_RETRAIN"
