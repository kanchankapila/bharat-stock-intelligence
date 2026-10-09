"""Shadow arms rebuilt from unified_recommendations_history (spec 2026-10-08 section 2.C.1)."""
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import accuracy_shadow_arms as A
from unified_ranker import REGIME_WEIGHTS, _normalize_to_100


def _panel(n_dates=60, n=200, seed=1):
    rng = np.random.default_rng(seed)
    frames = []
    for d in pd.bdate_range("2026-01-05", periods=n_dates):
        sig = rng.normal(size=n)
        frames.append(pd.DataFrame({
            "session": d, "symbol": [f"S{i}" for i in range(n)], "regime": "SIDEWAYS",
            "confluence_score": sig + 0.5 * rng.normal(size=n),
            "ml_score": rng.normal(size=n), "technical_score": rng.normal(size=n), "breakout_score": rng.normal(size=n),
            "fwd": 0.02 * sig + 0.02 * rng.normal(size=n),
        }))
    p = pd.concat(frames, ignore_index=True)
    p["unified_score"] = p["confluence_score"] + rng.normal(size=len(p))
    p["classification"] = np.where(p["unified_score"] > 1, "Buy", "Hold")
    return p


def _mean_ic(p, s):
    return float(A.session_ic(p, s, p["fwd"]).mean())


def test_reblend_is_the_percentile_normalised_regime_blend_over_present_engines():
    p = pd.DataFrame({
        "session": pd.Timestamp("2026-01-05"), "symbol": list("ABCD"), "regime": "bear",
        "ml_score": [10.0, 20.0, 30.0, 40.0], "confluence_score": [5.0, np.nan, 1.0, 9.0],
        "technical_score": [3.0, 3.0, 2.0, 1.0], "breakout_score": [1.0, 2.0, 3.0, 4.0],
        "unified_score": [1.0, 2.0, 3.0, 4.0], "classification": "Hold",
    })
    w = REGIME_WEIGHTS["BEAR"]
    norm = {e: _normalize_to_100({s: v for s, v in zip(p.symbol, p[f"{e}_score"]) if v == v}) for e in A.ENGINES}
    for sym, got in zip(p.symbol, A.reblend(p)):
        present = [e for e in A.ENGINES if sym in norm[e] and w[e] > 0]
        exp = sum(w[e] * norm[e][sym] for e in present) / sum(w[e] for e in present)
        assert abs(got - exp) < 1e-9, sym


def test_dropping_a_noise_engine_cannot_lower_ic_when_only_confluence_carries_signal():
    p = _panel()
    ic_all, ic_no_ml = _mean_ic(p, A.reblend(p)), _mean_ic(p, A.reblend_no_ml(p))
    assert ic_no_ml >= ic_all > 0.1


def test_random_control_carries_no_ic_and_keeps_the_published_distribution():
    p = _panel()
    r = A.random_control(p, seed=7)
    assert abs(_mean_ic(p, r)) < 0.05
    assert (A.random_control(p, seed=7) == r).all()                       # seeded, reproducible
    for _, g in p.assign(r=r).groupby("session"):
        assert np.allclose(np.sort(g["r"].values), np.sort(g["unified_score"].values))


def test_vol_veto_haircuts_only_the_top_vol_quintile_of_each_session():
    p = _panel(n_dates=2, n=10)
    vol = pd.Series(np.tile(np.arange(10, dtype=float), 2), index=p.index)
    base, vv = A.reblend(p), A.reblend_vol_veto(p, vol)
    top = vol >= 8                                                          # top 20% of 10 names
    assert np.allclose(vv[top], base[top] * 0.7) and np.allclose(vv[~top], base[~top])


def test_published_is_the_stored_score():
    p = _panel(n_dates=2, n=10)
    assert A.published(p).equals(p["unified_score"])


def test_arm_scores_returns_every_arm():
    p = _panel(n_dates=3, n=20)
    out = A.arm_scores(p, vol=pd.Series(1.0, index=p.index), seed=3)
    assert set(out.columns) == set(A.ARMS) and len(out) == len(p)
