"""A feature whose producer was retired trains on real values and scores on the fill default.

pead_score's nightly job was retired 2026-08-20 but ml_ensemble kept pead_score and pead_x_event
as features: real values on older training rows, 0.0 on every row scored since. The matrix-wide
drop_untrainable_features() cannot see it; drop_retired_source_features() must.
"""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ml_ensemble import build_features, drop_retired_source_features  # noqa: E402


def _frame(n_sessions=60, per_day=8):
    rng = np.random.default_rng(7)
    days = pd.bdate_range("2026-06-01", periods=n_sessions)
    rows = []
    for i, d in enumerate(days):
        for k in range(per_day):
            rows.append({
                "symbol": f"S{k}", "signal_date": d.strftime("%Y-%m-%d"), "horizon_days": 5, "outcome": k % 2,
                "rsi": float(rng.uniform(20, 80)),
                "event_signal_score": float(rng.uniform(-3, 3)),
                # dense daily producer, retired 20 sessions before the end
                "pead_score": float(rng.uniform(-1, 1)) if i < n_sessions - 20 else np.nan,
                # results-season column: written in bursts, quiet at the end -- must be kept
                "earnings_shocker_gain": float(rng.uniform(0, 10)) if (i // 10) % 2 == 0 and i < n_sessions - 20 else np.nan,
            })
    return pd.DataFrame(rows)


def test_features_from_a_retired_daily_source_are_dropped():
    df = _frame()
    X = build_features(df)
    assert "pead_score" in X.columns and "pead_x_event" in X.columns
    X2, report = drop_retired_source_features(df, X)
    assert list(report["retired_sources"]) == ["pead_score"]
    assert {"pead_score", "pead_x_event"} <= set(report["dropped"])
    assert "pead_score" not in X2.columns and "pead_x_event" not in X2.columns
    assert "event_score" in X2.columns  # shares an input with pead_x_event, still live


def test_seasonal_and_live_sources_are_kept():
    df = _frame()
    df["pead_score"] = np.random.default_rng(1).uniform(-1, 1, len(df))
    X = build_features(df)
    X2, report = drop_retired_source_features(df, X)
    assert report["retired_sources"] == {}
    assert list(X2.columns) == list(X.columns)


def test_short_history_is_never_judged():
    df = _frame(n_sessions=30)
    X = build_features(df)
    X2, report = drop_retired_source_features(df, X)
    assert report["dropped"] == [] and X2.shape == X.shape


def test_long_retired_daily_source_is_still_dropped():
    # Regression for AF-20261119-17: pead_score stopped 2026-08-19, so by Nov 2026
    # the gap after written.max() diluted span coverage below 0.90 when span ran to sessions[-20].
    df = _frame(n_sessions=100)
    days = sorted(df["signal_date"].unique())
    df["pead_score"] = np.where(df["signal_date"].isin(days[:30]), df["pead_score"].fillna(0.25), np.nan)
    X = build_features(df)
    X2, report = drop_retired_source_features(df, X)
    assert "pead_score" in report["retired_sources"]
    assert "pead_score" not in X2.columns and "pead_x_event" not in X2.columns


def test_single_day_blip_is_not_treated_as_retired_daily_source():
    df = _frame(n_sessions=60)
    days = sorted(df["signal_date"].unique())
    df["pead_score"] = np.where(df["signal_date"] == days[0], 0.5, np.nan)
    X = build_features(df)
    X2, report = drop_retired_source_features(df, X)
    assert "pead_score" not in report["retired_sources"]
    assert "pead_score" in X2.columns
