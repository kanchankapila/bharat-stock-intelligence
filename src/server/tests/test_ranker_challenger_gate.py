"""ranker_challenger_gate.evaluate (AF-20261119): pure, on a synthetic accuracy_scorecard snapshot."""
import numpy as np
import pandas as pd

import ranker_challenger_gate as G


def _series(ic, start="2025-01-01"):
    dates = [str(d.date()) for d in pd.bdate_range(start, periods=len(ic))]
    return {"dates": dates, "ic": [None if v != v else float(v) for v in ic]}


def _scorecard(arms: dict, n=200, seed=0, excess=None):
    rng = np.random.default_rng(seed)
    base = 0.02 + 0.05 * rng.normal(size=n)
    ics = {"published": {h: _series(base) for h in ("5", "10", "21")}}
    for name, lift in arms.items():
        ics[name] = {h: _series(base + lift + 0.01 * rng.normal(size=n)) for h in ("5", "10", "21")}
    rows = [{"arm": a, "horizon": 5, "regime": "ALL", "floor": 1e8, "tier": 0.1,
             "excess_050_pct": (excess or {}).get(a, 0.1)} for a in ics]
    return {"ic_series": ics, "rows": rows}


def test_a_better_arm_is_a_candidate_and_worse_or_equal_arms_are_not():
    res = G.evaluate(_scorecard({"better": 0.01, "worse": -0.01, "same": 0.0, "random_control": -0.02}))
    v = {a: r["verdict"] for a, r in res["arms"].items()}
    assert v == {"better": "CANDIDATE", "worse": "WORSE", "same": "NO DIFFERENCE", "random_control": "WORSE"}
    assert res["candidates"] == ["better"] and res["status"] == "OK"


def test_few_independent_windows_is_low_data_not_a_verdict():
    res = G.evaluate(_scorecard({"better": 0.05}, n=60))      # 60 sessions / h5 = 12 windows < 20
    assert res["arms"]["better"]["verdict"] == "LOW-DATA" and res["candidates"] == []


def test_a_candidate_must_not_lose_top_decile_excess():
    res = G.evaluate(_scorecard({"better": 0.01}, excess={"published": 0.3, "better": 0.1}))
    assert res["arms"]["better"]["verdict"] == "NO DIFFERENCE"


def test_noise_reading_as_a_candidate_invalidates_the_gate():
    res = G.evaluate(_scorecard({"random_control": 0.02}))
    assert res["status"] == "INVALID"


def test_null_values_from_the_snapshot_are_skipped():
    sc = _scorecard({"better": 0.01})
    sc["ic_series"]["better"]["5"]["ic"][3] = None
    assert G.evaluate(sc)["arms"]["better"]["horizons"]["5"]["dates"] == 199
