"""Grading an arbitrary call source (e.g. bharat_alpha) under the frozen forward-test rules (spec 2.C.4)."""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import forward_test_report as ftr
import graded_alpha_adapter as G


def _panel(edge: float, n_dates=300, n=150, seed=11):
    rng = np.random.default_rng(seed)
    frames = []
    for d in pd.bdate_range("2025-01-06", periods=n_dates):
        s = rng.normal(size=n)
        frames.append(pd.DataFrame({"date": d, "symbol": [f"S{i}" for i in range(n)], "score": s,
                                    "fwd": edge * s + 0.04 * rng.normal(size=n)}))
    return pd.concat(frames, ignore_index=True)


def _row(rows, tier):
    return next(r for r in rows if r["tier"] == tier)


def test_shuffled_control_reads_no_edge_on_a_no_edge_panel():
    out = G.grade_panel(_panel(edge=0.0), horizon=5)
    assert abs(_row(out["control"], 0.10)["t_eff"]) < 1
    assert abs(_row(out["gross"], 0.10)["t_eff"]) < 2          # the real (no-edge) score is not graded as an edge either


def test_positive_control_reads_an_edge_and_the_control_still_does_not():
    out = G.grade_panel(_panel(edge=0.01), horizon=5)
    assert _row(out["gross"], 0.10)["t_eff"] >= 2 and _row(out["gross"], 0.10)["hit_lift"] > 0
    assert abs(_row(out["control"], 0.10)["t_eff"]) < 1


def test_net_tiers_charge_the_frozen_cost():
    p = _panel(edge=0.0, n_dates=40)
    out = G.grade_panel(p, horizon=5)
    gross, net = _row(out["gross"], 1.0), _row(out["net"], 1.0)
    assert abs((gross["mean_excess_pct"] - net["mean_excess_pct"]) - 2 * ftr.PROTOCOL["cost_per_side"] * 100) < 1e-9


def test_grade_calls_maps_publications_to_sessions_like_the_forward_test():
    sess = pd.bdate_range("2026-01-05", periods=10)
    calls = pd.DataFrame({"symbol": ["A", "A"], "score": [1.0, 2.0],
                          "generated_at": [pd.Timestamp(f"{sess[3].date()} 18:00", tz="Asia/Kolkata"),
                                           pd.Timestamp(f"{sess[4].date()} 06:00", tz="Asia/Kolkata")]})
    out = G.to_sessions(calls, sess)
    assert list(out["session"]) == [sess[3]] and out["score"].iloc[0] == 2.0   # the pre-open call is the same session's latest
