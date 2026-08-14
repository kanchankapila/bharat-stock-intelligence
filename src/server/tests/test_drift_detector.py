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
        calls = []

        def fake_query_one(sql, params=()):
            calls.append((sql, params))
            return {"drift_score": 0.10}

        monkeypatch.setattr(dd, "query_one", fake_query_one)
        result = dd.get_drift_multiplier()
        assert len(calls) == 1, "must call query_one exactly once, with no extra conn argument"
        assert result == 1.0

    def test_no_drift_row_defaults_to_no_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: None)
        assert dd.get_drift_multiplier() == 1.0

    def test_warn_threshold_applies_moderate_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"drift_score": dd.PSI_WARN + 0.01})
        assert dd.get_drift_multiplier() == 0.93

    def test_critical_threshold_applies_full_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"drift_score": dd.PSI_CRIT + 0.01})
        assert dd.get_drift_multiplier() == 0.85

    def test_below_warn_threshold_no_haircut(self, monkeypatch):
        monkeypatch.setattr(dd, "query_one", lambda *a, **k: {"drift_score": 0.05})
        assert dd.get_drift_multiplier() == 1.0

    def test_a_genuinely_broken_query_still_degrades_gracefully_to_no_haircut(self, monkeypatch):
        """If query_one itself raises for an unrelated reason (DB down), the function
        must still return the safe default rather than propagating the exception --
        this is deliberate resilience, distinct from the arity bug being regression-
        tested above (which raised on every single call, not just failures)."""
        def always_raises(*a, **k):
            raise RuntimeError("DB unavailable")
        monkeypatch.setattr(dd, "query_one", always_raises)
        assert dd.get_drift_multiplier() == 1.0
