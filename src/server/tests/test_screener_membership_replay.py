"""AF-20261106-04: the replay's two membership definitions must be exactly what they claim.

`old_arm` is production's `load_today_appearances` (3-day appeared window); `new_arm` is every open episode
minus the ones a dead sync stopped confirming. A replay that grades one against the other is only evidence if
the old arm IS production, so the pin test below runs both against the same table."""
import datetime as dt
import importlib.util
import os
import sys

import pandas as pd

SERVER = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER)
_spec = importlib.util.spec_from_file_location(
    "screener_membership_replay", os.path.join(SERVER, "..", "..", "scripts", "screener_membership_replay.py"))
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)
import screener_features_fetcher as F  # noqa: E402

D = dt.date(2026, 11, 20)


def _ep(rows):
    df = pd.DataFrame(rows, columns=["source", "screener_id", "symbol", "a", "x", "last_seen"])
    for c in ("a", "x", "last_seen"):
        df[c] = pd.to_datetime(df[c])
    return df


def test_old_arm_is_the_three_day_window_and_keeps_same_day_exits():
    ep = _ep([
        ("etnow", "1", "NEW", "2026-11-18", None, None),        # appeared 2 days ago, open
        ("etnow", "1", "EDGE", "2026-11-17", None, None),       # exactly 3 days ago, still inside
        ("etnow", "1", "OLD", "2026-11-16", None, None),        # long-running: production drops it
        ("etnow", "1", "EXITED_BEFORE", "2026-11-18", "2026-11-19", None),
        ("etnow", "1", "EXITS_TODAY", "2026-11-18", "2026-11-20", None),   # `exited_date >= as_of` keeps it
        ("etnow", "1", "FUTURE", "2026-11-21", None, None),     # not yet appeared on D
    ])
    assert sorted(R.old_arm(ep, D)["symbol"]) == ["EDGE", "EXITS_TODAY", "NEW"]


def test_new_arm_keeps_long_running_but_drops_episodes_a_dead_sync_stopped_confirming():
    ep = _ep([
        ("etnow", "1", "LONG_LIVE", "2026-06-01", None, "2026-11-20"),     # open, confirmed today
        ("etnow", "1", "LONG_GRACE", "2026-06-01", None, "2026-11-17"),    # confirmed 3 days ago: inside grace
        ("etnow", "1", "LONG_DEAD", "2026-06-01", None, "2026-11-05"),     # open but its sync died
        ("etnow", "1", "LONG_NOROW", "2026-06-01", None, None),            # open, no stocks row at all
        ("etnow", "1", "CLOSED_AFTER", "2026-06-01", "2026-11-25", None),  # exits after D: a member on D
        ("etnow", "1", "CLOSED_BEFORE", "2026-06-01", "2026-11-10", None),
        ("etnow", "1", "FUTURE", "2026-11-21", None, "2026-11-20"),
    ])
    assert sorted(R.new_arm(ep, D)["symbol"]) == ["CLOSED_AFTER", "LONG_GRACE", "LONG_LIVE"]


def test_shared_screener_ids_are_dropped_from_both_arms():
    ep = _ep([
        ("etnow", "173", "A", "2026-11-19", None, "2026-11-20"),
        ("moneycontrol", "173", "A", "2026-11-19", None, "2026-11-20"),
        ("etnow", "9", "B", "2026-11-19", None, "2026-11-20"),
    ])
    kept = R.drop_shared(ep, {("etnow", "173"), ("moneycontrol", "173")})
    assert sorted(kept["screener_id"]) == ["9"]


def test_old_arm_equals_production_load_today_appearances(pg_conn):
    """Same rows, same date: the replay's old arm and the fetcher's own loader return the same set."""
    pg_conn.execute("""CREATE TABLE screener_appearances (
        screener_id TEXT NOT NULL, source TEXT NOT NULL, symbol TEXT NOT NULL, appeared_date TIMESTAMPTZ NOT NULL,
        exited_date TIMESTAMPTZ, PRIMARY KEY (source, screener_id, symbol, appeared_date))""")
    rows = [("1", "etnow", "NEW", "2026-11-19", None), ("1", "etnow", "LONG", "2026-06-01", None),
            ("2", "moneycontrol", "NEW", "2026-11-18", None), ("2", "moneycontrol", "GONE", "2026-11-18", "2026-11-19"),
            ("3", "trendlyne", "TODAY", "2026-11-20", None), ("3", "trendlyne", "EXITS", "2026-11-17", "2026-11-20")]
    for r in rows:
        pg_conn.execute("INSERT INTO screener_appearances VALUES (?, ?, ?, ?, ?)", r)
    produced = {(sym, src, sid) for sym, ids in F.load_today_appearances(pg_conn, D.isoformat()).items() for src, sid in ids}
    ep = R.load_episodes(pg_conn, dt.date(2026, 5, 1))
    arm = R.old_arm(ep, D)
    assert produced == set(zip(arm["symbol"], arm["source"], arm["screener_id"]))
    assert produced and "LONG" not in {s for s, _, _ in produced}
