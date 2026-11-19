"""Pure-function tests for plan_rule_measure.py (AF-20261117-14 / -16); no database needed."""
import datetime

import pandas as pd

import plan_rule_measure as m

SESSIONS = pd.DatetimeIndex(pd.bdate_range("2026-11-02", periods=15))


def test_monthly_expiry_switches_from_thursday_to_tuesday():
    assert m.monthly_expiry(2025, 8) == datetime.date(2025, 8, 28)    # last Thursday
    assert m.monthly_expiry(2026, 11) == datetime.date(2026, 11, 24)  # last Tuesday
    assert m.monthly_expiry(2026, 12) == datetime.date(2026, 12, 29)


def test_event_must_fall_inside_the_holding_window():
    d = SESSIONS[0]  # entry SESSIONS[1] (Nov 3), exit SESSIONS[6] (Nov 10) at h=5
    buys = pd.DataFrame({"symbol": ["IN", "EDGE", "OUT", "NOTFNO"], "date": [d] * 4})
    ex = {"IN": [datetime.date(2026, 11, 5)], "EDGE": [datetime.date(2026, 11, 2)],  # signal day, pre-entry
          "OUT": [datetime.date(2026, 11, 11)]}
    out = m.flag_events(buys, SESSIONS, 5, ex, lambda _d: {"IN"})
    assert out["has_exdate"].tolist() == [True, False, False, False]
    assert out["has_expiry"].tolist() == [False] * 4  # Nov 24 expiry is after the window

    late = pd.DataFrame({"symbol": ["IN", "NOTFNO"], "date": [SESSIONS[12]] * 2})  # Nov 18: window spans Nov 24
    out = m.flag_events(late, pd.DatetimeIndex(pd.bdate_range("2026-11-02", periods=30)), 5, {}, lambda _d: {"IN"})
    assert out["has_expiry"].tolist() == [True, False]


def test_downgrade_exits_at_the_next_open_and_ignores_unranked_sessions():
    s = SESSIONS
    buys = pd.DataFrame({"symbol": ["DOWN", "GAP", "KEEP"], "date": [s[0]] * 3})
    cls = {("DOWN", s[2]): "Hold", ("GAP", s[2]): None, ("KEEP", s[3]): "Strong Buy"}
    opens = {(sym, d): 100.0 for sym in ("DOWN", "GAP", "KEEP") for d in s}
    opens[("DOWN", s[3])] = 104.0   # exit open, the session after the downgrade
    opens[("DOWN", s[6])] = 98.0    # hold exit
    out = m.downgrade_effect(buys, cls, opens, s, 5, cost=0.005)
    assert out["symbol"].tolist() == ["DOWN"]          # GAP had no call that session: not a downgrade
    row = out.iloc[0]
    assert round(row["exit_ret"], 4) == 0.035 and round(row["hold_ret"], 4) == -0.025
    assert round(row["diff"], 4) == 0.06


def test_paired_by_date_compares_within_a_date_and_marks_small_samples_low_data():
    a = pd.DataFrame({"date": [1, 1, 2, 2, 3], "v": [0.03, 0.01, 0.02, 0.0, 0.5], "f": [True, False, True, False, True]})
    res = m.paired_by_date(a, "v", "f", horizon=5)
    assert res["dates"] == 2                            # date 3 has no comparison group
    assert round(res["mean_pct"], 6) == 2.0
    assert res["verdict"] == "LOW-DATA"
