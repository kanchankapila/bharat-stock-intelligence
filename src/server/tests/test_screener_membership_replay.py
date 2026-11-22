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


# ── capture-only fix (AF-20261106-04): the snapshot records the gated open set, features keep the old window ──

def _create_capture_tables(conn):
    conn.execute("""CREATE TABLE screener_appearances (
        screener_id TEXT NOT NULL, source TEXT NOT NULL, symbol TEXT NOT NULL, appeared_date TIMESTAMPTZ NOT NULL,
        exited_date TIMESTAMPTZ, PRIMARY KEY (source, screener_id, symbol, appeared_date))""")
    conn.execute("CREATE TABLE etnow_screener_stocks (screener_id TEXT, symbol TEXT, last_seen TEXT)")
    conn.execute("CREATE TABLE moneycontrol_screener_stocks (scan_id TEXT, symbol TEXT, last_seen TEXT)")
    conn.execute("CREATE TABLE trendlyne_screener_stocks (screener_id TEXT, symbol TEXT, last_seen TEXT)")
    conn.execute("CREATE TABLE et_marketstats_screener_stocks (screener_key TEXT, symbol TEXT, last_seen TEXT)")


def test_open_memberships_sql_equals_the_replay_new_arm(pg_conn):
    _create_capture_tables(pg_conn)
    ep = [("1", "etnow", "LIVE", "2026-06-01", None), ("1", "etnow", "DEAD", "2026-06-01", None),
          ("1", "etnow", "NOROW", "2026-06-01", None), ("1", "etnow", "EXITS_LATER", "2026-06-01", "2026-11-25"),
          ("2", "moneycontrol", "NEW", "2026-11-19", None), ("3", "trendlyne", "OLD", "2026-07-01", None),
          ("4", "et_marketstats", "ETM", "2026-07-01", None), ("4", "et_marketstats", "CLOSED", "2026-07-01", "2026-11-10")]
    for r in ep:
        pg_conn.execute("INSERT INTO screener_appearances VALUES (?, ?, ?, ?, ?)", r)
    pg_conn.execute("INSERT INTO etnow_screener_stocks VALUES ('1', 'LIVE', '2026-11-20'), ('1', 'DEAD', '2026-11-05')")
    pg_conn.execute("INSERT INTO moneycontrol_screener_stocks VALUES ('2', 'NEW', '2026-11-20')")
    pg_conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('3', 'OLD', '2026-11-17')")
    pg_conn.execute("INSERT INTO et_marketstats_screener_stocks VALUES ('4', 'ETM', '2026-11-20')")
    produced = {(sym, src, sid) for sym, ids in F.load_open_memberships(pg_conn, D.isoformat()).items() for src, sid in ids}
    arm = R.new_arm(R.attach_last_seen(R.load_episodes(pg_conn, dt.date(2026, 5, 1)), R.load_last_seen(pg_conn)), D)
    assert produced == set(zip(arm["symbol"], arm["source"], arm["screener_id"]))
    assert {s for s, _, _ in produced} == {"LIVE", "EXITS_LATER", "NEW", "OLD", "ETM"}   # DEAD and NOROW are not confirmed


def test_snapshot_writes_every_member_once_and_a_repeat_run_adds_no_duplicates(pg_conn):
    members = {"AAA": [("etnow", "1"), ("trendlyne", "9")], "BBB": [("etnow", "1")]}
    assert F.snapshot_membership(pg_conn, D.isoformat(), members) == 3
    F.snapshot_membership(pg_conn, D.isoformat(), members)
    assert pg_conn.execute("SELECT count(*) FROM screener_membership_snapshot").fetchone()[0] == 3
    assert pg_conn.execute("SELECT count(*) FROM screener_membership_runs").fetchone()[0] == 2


def test_run_captures_the_open_set_but_builds_features_from_the_legacy_window():
    import inspect
    src = inspect.getsource(F.run)
    assert "load_open_memberships(" in src and "snapshot_membership(con, as_of, open_members)" in src
    assert "for symbol, screener_ids in appearances.items()" in src      # features: unchanged definition
