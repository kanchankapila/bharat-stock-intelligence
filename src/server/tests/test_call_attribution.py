"""call_attribution.py pure functions (AF-20261119): every cause, the path statistics, an end-to-end panel."""
import datetime

import numpy as np
import pandas as pd

import call_attribution as CA

COST = 0.005


def _c(**o):
    base = {"excess": -0.01, "gross_excess": -0.008, "excess_2h": -0.01, "sector_rel": 0.0, "idio": -0.01,
            "unfillable": False, "has_exdate": False, "stop_hit": False, "target_after_stop": False}
    return {**base, **o}


def test_each_cause_in_priority_order():
    assert CA.classify_cause(_c(excess=0.001), COST) == "HIT"
    assert CA.classify_cause(_c(unfillable=True, has_exdate=True), COST) == "UNFILLABLE"
    assert CA.classify_cause(_c(has_exdate=True, stop_hit=True), COST) == "EVENT"
    assert CA.classify_cause(_c(stop_hit=True, gross_excess=0.002), COST) == "STOP_TOO_TIGHT"
    assert CA.classify_cause(_c(stop_hit=True, target_after_stop=True), COST) == "STOP_TOO_TIGHT"
    assert CA.classify_cause(_c(gross_excess=0.002), COST) == "COST"
    assert CA.classify_cause(_c(excess_2h=0.01), COST) == "TOO_SLOW"
    assert CA.classify_cause(_c(idio=0.004, sector_rel=-0.02), COST) == "SECTOR_DRAG"
    assert CA.classify_cause(_c(), COST) == "WRONG_PICK"
    # A stop touch alone is not "too tight": the hold also lost, so the stop did its job.
    assert CA.classify_cause(_c(stop_hit=True), COST) == "WRONG_PICK"


def test_path_stats_orders_target_after_stop():
    bars = pd.DataFrame({"open": [100, 97, 99], "high": [101, 98, 112], "low": [99, 94, 97], "close": [100, 96, 110]})
    ps = CA.path_stats(bars, 100.0, stop=95.0, target=110.0)
    assert ps["stop_hit"] and ps["target_hit"] and ps["target_after_stop"]
    assert round(ps["mae"], 4) == -0.06 and round(ps["mfe"], 4) == 0.12
    ps = CA.path_stats(bars.iloc[:2], 100.0, stop=None, target=110.0)
    assert not ps["stop_hit"] and not ps["target_hit"]


def test_attribute_end_to_end_on_a_small_panel():
    sessions = pd.DatetimeIndex(pd.bdate_range("2026-11-02", periods=14))
    d = sessions[0]
    # 4 liquid names in one sector; GOOD beats everyone, BAD lags its sector, LOCK opened locked limit-up.
    panel = pd.DataFrame({
        "date": d, "symbol": ["GOOD", "BAD", "LOCK", "HOLDX"], "classification": ["Buy", "Buy", "Strong Buy", "Hold"],
        "unified_score": [80, 75, 90, 50], "sector": "IT", "regime": "SIDEWAYS", "adt": [2e8, 2e7, 6e8, 1e8],
        "stop_loss": [90.0, 90.0, 90.0, np.nan], "target_1": [115.0, 115.0, 115.0, np.nan],
        "fwd_5": [0.05, -0.04, -0.02, 0.01], "fwd_10": [0.06, -0.05, 0.0, 0.01],
    })
    def bars(o):
        idx = sessions[: len(o)]
        return pd.DataFrame({"open": o, "high": [x * 1.01 for x in o], "low": [x * 0.99 for x in o], "close": o}, index=idx)
    b = {"GOOD": bars([100.0] * 14), "BAD": bars([100.0] * 14)}
    lock = bars([100.0] * 14)
    lock.iloc[1] = [110.0, 110.0, 110.0, 110.0]                       # entry session: one price, above prior close
    b["LOCK"] = lock
    out = CA.attribute(panel, b, sessions, 5, COST, ex_dates={})
    cause = dict(zip(out["symbol"], out["cause"]))
    assert cause == {"GOOD": "HIT", "BAD": "WRONG_PICK", "LOCK": "UNFILLABLE"}   # the Hold is not a call
    assert set(out["adt_band"]) == {"10-50cr", "1-10cr", "50cr+"}
    s = CA.summarise(out, 5)
    assert s["calls"] == 3 and s["hits"] == 1 and s["cause_counts"]["WRONG_PICK"] == 1
    assert s["overall"]["low_data"] is True


def test_exdate_inside_the_hold_is_an_event_but_the_signal_day_is_not():
    sessions = pd.DatetimeIndex(pd.bdate_range("2026-11-02", periods=14))
    panel = pd.DataFrame({"date": sessions[0], "symbol": ["EXD", "PEER1", "PEER2"], "classification": ["Buy", "Hold", "Hold"],
                          "unified_score": [80, 1, 1], "sector": "IT", "regime": "SIDEWAYS", "adt": 2e8,
                          "stop_loss": np.nan, "target_1": np.nan, "fwd_5": [-0.05, 0.02, 0.02], "fwd_10": [-0.05, 0.02, 0.02]})
    b = {"EXD": pd.DataFrame({"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0}, index=sessions)}
    inside = CA.attribute(panel, b, sessions, 5, COST, {"EXD": [datetime.date(2026, 11, 5)]})
    signal_day = CA.attribute(panel, b, sessions, 5, COST, {"EXD": [datetime.date(2026, 11, 2)]})
    assert inside["cause"].iat[0] == "EVENT" and signal_day["cause"].iat[0] != "EVENT"


def test_stop_study_reports_the_dip_most_winners_survived():
    att = pd.DataFrame({"cause": ["HIT"] * 10 + ["WRONG_PICK"], "date": pd.Timestamp("2026-11-02"),
                        "excess": [0.01] * 10 + [-0.02], "regime": "SIDEWAYS", "adt_band": "50cr+", "sector": "IT",
                        "mae": [-0.01 * k for k in range(1, 11)] + [-0.2], "stop_dist": -0.03})
    st = CA.summarise(att, 5)["stops"]
    # Winner dips are -1%..-10%: 80% of them dipped no deeper than ~-8.2% (the 20th percentile of MAE; the 80th,
    # -2.8%, would claim only 20% of winners went deeper). The loser's -20% is not counted.
    assert -8.5 < st["winner_mae_p80_pct"] < -8.0
    assert st["winners_whose_mae_crossed_stop"] == 0.8      # dips of -3%..-10% reached a -3% stop
