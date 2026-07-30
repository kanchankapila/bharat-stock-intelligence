import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import drift_detector as dd


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
