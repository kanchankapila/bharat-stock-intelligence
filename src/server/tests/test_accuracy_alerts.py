"""Alerts evaluated from a scorecard dict (spec 2026-10-08, section 2.C.3). Pure functions, injected data."""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import accuracy_alerts as AL


def _snap(lift, ci, eff=25.0):
    return {"rows": [{"arm": "published", "tier": "published", "horizon": 5, "floor": 1e8, "regime": "ALL",
                      "eff_dates": eff, "hit_lift": lift, "hit_ci95": ci}]}


def test_lift_ci_alert_needs_three_consecutive_snapshots_past_the_window_floor():
    bad, good = _snap(0.01, 0.03), _snap(0.08, 0.03)
    assert AL.lift_ci_alert([bad, bad, bad])
    assert not AL.lift_ci_alert([bad, bad])                         # only two
    assert not AL.lift_ci_alert([bad, good, bad, bad])              # last three not all bad
    assert AL.lift_ci_alert([good, bad, bad, bad])
    assert not AL.lift_ci_alert([_snap(0.01, 0.03, eff=12)] * 3)    # under 20 independent windows: LOW-DATA, no alert


def _cal(diff, lo, hi, brier=0.25, base=0.22):
    return {"calibration": {"5": {"brier": brier, "brier_base": base, "n": 100,
                                  "trailing": {"n": 100, "diff": diff, "ci95": [lo, hi]}}}}


def test_brier_alert_reads_the_trailing_benchmark_not_the_hindsight_one():
    # AF-20261008-45: the same-period base rate is unknowable in advance; only a trailing purged one is fair.
    assert AL.brier_alert(_cal(0.05, 0.03, 0.07))                   # worse, CI excludes zero
    assert not AL.brier_alert(_cal(0.004, -0.001, 0.009))           # hindsight says worse, trailing is noise
    assert not AL.brier_alert(_cal(-0.01, -0.02, -0.001))           # better than the trailing base
    assert not AL.brier_alert({"calibration": {"5": {"brier": 0.25, "brier_base": 0.22, "n": 100}}})  # not measured


def test_top_decile_dispersion_collapse():
    healthy = [0.95] * 25
    assert AL.dispersion_alert({"dispersion": {"dates": list(range(26)), "top_decile_distinct_share": healthy + [0.2]}})
    assert not AL.dispersion_alert({"dispersion": {"dates": list(range(26)), "top_decile_distinct_share": healthy + [0.9]}})


def test_rolling_ic_sign_change_over_20_windows():
    h = 5
    flip = [0.05] * (20 * h) + [-0.05] * (20 * h)
    steady = [0.05] * (40 * h)
    assert AL.rolling_ic_sign_change(flip, h)
    assert not AL.rolling_ic_sign_change(steady, h)
    assert not AL.rolling_ic_sign_change(flip[: 30 * h], h)          # fewer than 2 x 20 independent windows
    sc = {"ic_series": {"reblend": {"5": {"dates": list(range(len(flip))), "ic": flip}}}}
    assert AL.ic_sign_alerts(sc)[0]["detail"]["arm"] == "reblend"


def _feature_panel(n_dates=25, n=400, seed=3, countdown_on_last=False):
    rng = np.random.default_rng(seed)
    frames = []
    for i, d in enumerate(pd.bdate_range("2026-08-03", periods=n_dates)):
        v = rng.integers(0, 90, size=n).astype(float)
        v[rng.random(n) < 0.7] = np.nan                     # an event countdown is sparse when honest
        if countdown_on_last and i == n_dates - 1:
            v = np.where(rng.random(n) < 0.92, 2.0, v)      # forward-filled: 92% of the universe "reports in 2 days"
        frames.append(pd.DataFrame({"date": d, "symbol": range(n), "days_to_next_results": v}))
    return pd.concat(frames, ignore_index=True)


def test_feature_collapse_trips_on_a_forward_filled_countdown():
    a = AL.feature_collapse(_feature_panel(countdown_on_last=True), "days_to_next_results")
    assert a and a["code"] == "feature_collapse" and "modal_share" in a["detail"]["tripped"]


def test_feature_collapse_is_silent_on_a_clean_column():
    assert AL.feature_collapse(_feature_panel(), "days_to_next_results") is None


def test_feature_collapse_trips_when_a_column_stops_being_written():
    p = _feature_panel()
    p.loc[p["date"] == p["date"].max(), "days_to_next_results"] = np.nan
    assert "non_null_share" in AL.feature_collapse(p, "days_to_next_results")["detail"]["tripped"]


def test_evaluate_collects_alerts():
    bad = _snap(0.01, 0.03)
    bad["calibration"] = _cal(0.05, 0.03, 0.07)["calibration"]
    codes = {a["code"] for a in AL.evaluate(bad, history=[bad, bad])}
    assert codes == {"published_lift_ci", "brier_worse_than_base"}
