"""gap_up_delay_shadow: forward test of "buy a gapped-up Buy name at 15:15 instead of the open" (AF-20261126-15,
docs/audits/2026-11-26-gap-up-delay-shadow-preregistration.md). Each test pins one rule that would make the forward
result dishonest if it broke."""
import datetime as dt
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import gap_up_delay_shadow as G

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))


def _row(symbol, gap, open_=100.0, buy_at=100.0, adt=20.0, surv=False, ca=False, dclose=None, locked=False):
    return {"symbol": symbol, "adt": adt, "surv": surv, "ca": ca, "gap": gap, "open": open_, "close_1500": buy_at,
            "high_1500": buy_at if locked or buy_at is None else buy_at + 1,
            "low_1500": buy_at if locked or buy_at is None else buy_at - 1,
            "dclose": buy_at if dclose is None else dclose}


def _others(buy_at=100.0):
    return [_row(s, 0.0, buy_at=buy_at) for s in ("O1", "O2", "O3")]


def test_d_is_gap_up_saving_minus_other_saving():
    day = G.grade_day([_row("UP", 1.5, buy_at=98.0), *_others(buy_at=101.0)])
    assert day["status"] == "graded"
    assert day["up_save"] == pytest.approx(2.0)
    assert day["other_save"] == pytest.approx(-1.0)
    assert day["D"] == pytest.approx(3.0)
    assert (day["n_up"], day["n_other"]) == (1, 3)
    assert day["up"] == {"UP": pytest.approx(2.0)}


def test_threshold_is_one_percent_inclusive():
    day = G.grade_day([_row("EDGE", 1.0), _row("BELOW", 0.99), *_others()])
    assert day["n_up"] == 1 and day["n_other"] == 4


def test_fewer_than_three_others_gives_no_d():
    day = G.grade_day([_row("UP", 2.0), *_others()[:2]])
    assert day["status"] == "no_d" and day["reason"] == "too_few_others" and day["D"] is None


def test_no_gap_up_name_gives_no_d():
    day = G.grade_day(_others())
    assert day["status"] == "no_d" and day["reason"] == "no_gap_up"


def test_guards_drop_names_and_count_why():
    rows = [_row("UP", 2.0), *_others(),
            _row("THIN", 2.0, adt=9.9), _row("ASM", 2.0, surv=True), _row("SPLIT", 2.0, ca=True),
            _row("NOGAP", None), _row("NOBAR", 2.0, buy_at=None, dclose=100.0),
            _row("BADPX", 2.0, buy_at=100.0, dclose=104.0)]
    day = G.grade_day(rows)
    assert (day["n_up"], day["n_other"]) == (1, 3)
    assert day["drops"] == {"below_adt": 1, "surveillance": 1, "corporate_action": 1, "no_preopen_row": 1,
                            "no_price": 1, "price_mismatch": 1}


def test_locked_name_is_kept_and_counted():
    # Dropping circuit-locked names would remove exactly the cases where waiting cost the most.
    day = G.grade_day([_row("LOCK", 5.0, buy_at=110.0, locked=True), *_others()])
    assert day["n_up"] == 1 and day["up_save"] == pytest.approx(-10.0) and day["locked_up"] == 1


def _days(n, d_val, up_save=0.4, start=dt.date(2027, 1, 1)):
    return [{"d": (start + dt.timedelta(days=i)).isoformat(), "status": "graded",
             "D": d_val(i), "up_save": up_save} for i in range(n)]


def _noisy(mean):
    return lambda i: mean + (0.1 if i % 2 else -0.1)


def test_no_verdict_before_150_graded_days_however_strong():
    s = G.summarise(_days(149, _noisy(5.0)))
    assert s["verdict"] == "LOW-DATA" and s["graded_days"] == 149


def test_pass_needs_all_three_conditions():
    assert G.summarise(_days(150, _noisy(0.5)))["verdict"] == "PASS"
    # relative spread positive, but delaying the gap-up names loses money: not a pass
    assert G.summarise(_days(150, _noisy(0.5), up_save=-0.1))["verdict"] == "FAIL"
    # second half negative
    assert G.summarise(_days(150, lambda i: 2.0 if i < 75 else -0.05))["verdict"] == "FAIL"
    # mean and both halves positive, only t below 1.65
    noisy = G.summarise(_days(150, lambda i: 0.2 + (3.0 if i % 2 else -3.0)))
    assert noisy["verdict"] == "FAIL" and min(noisy["halves"]) > 0 and 0 < noisy["t"] < 1.65


def test_verdict_is_fixed_on_the_first_150_graded_days():
    first = _days(150, _noisy(0.5))
    later = _days(100, _noisy(-5.0), start=dt.date(2027, 8, 1))
    s = G.summarise(first + later)
    assert s["verdict"] == "PASS" and s["graded_days"] == 250


def test_ungraded_days_do_not_count_towards_150():
    s = G.summarise(_days(149, _noisy(0.5)) + [{"d": "2028-01-01", "status": "no_d", "reason": "no_preopen", "D": None}])
    assert s["verdict"] == "LOW-DATA" and s["graded_days"] == 149 and s["days_without_d"] == {"no_preopen": 1}


# --- against the real schema ---------------------------------------------------------------------------------------

SESSIONS = [dt.date(2026, 11, d) for d in (18, 19, 20, 23, 25, 26, 27, 30)] + [dt.date(2026, 12, 1)]
# 20 prior daily bars are needed for ADT, so history starts well before the first session used.
HISTORY = [dt.date(2026, 10, 1) + dt.timedelta(days=i) for i in range(40)]
NAMES = ["UP", "O1", "O2", "O3", "LATE"]
TEST_PROTOCOL = dict(G.PROTOCOL, min_symbols=1)


def _seed(con, days=SESSIONS):
    for i, s in enumerate(NAMES):
        con.execute("INSERT INTO nse_stocks (id, symbol, name) VALUES (?, ?, ?)", (i + 1, s, s))
        for d in [h for h in HISTORY if h < days[0]] + days:
            con.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
                        "VALUES (?, ?, 100, 101, 99, 100, 5000000)", (s, d))
    for d in days:
        con.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
                    "VALUES ('NIFTY50', ?, 1, 1, 1, 1, 1)", (d,))
        for s in NAMES:
            px = 98.0 if s == "UP" else 100.0
            for hh, mm, close in ((9, 15, 100.0), (15, 0, px)):
                con.execute("INSERT INTO intraday_ohlcv (symbol, datetime, open, high, low, close, volume, interval) "
                            "VALUES (?, ?, ?, ?, ?, ?, 1000, '15m')",
                            (s, dt.datetime(d.year, d.month, d.day, hh, mm, tzinfo=IST), close, close + 1,
                             close - 1, close))
            stamp = "10:30:00" if s == "LATE" else "09:10:01"
            con.execute("INSERT INTO preopen_stock_snapshot (symbol, snapshot_date, iep_gap_pct, fetched_at) "
                        "VALUES (?, ?, ?, ?)", (s, d, 2.0 if s in ("UP", "LATE") else 0.0, f"{d}T{stamp}.5"))
    # published after the close of each session, so it is the call for the NEXT session's open
    for d in days:
        for s in NAMES:
            ts = dt.datetime(d.year, d.month, d.day, 18, 0, tzinfo=IST)
            con.execute("INSERT INTO unified_recommendations_history "
                        "(symbol, computed_at, generated_at, unified_score, classification) VALUES (?, ?, ?, 70, 'Buy')",
                        (s, ts.isoformat(), ts))
    con.commit()


def _stored(con):
    row = con.execute("SELECT value FROM app_settings WHERE key = ?", (G.REPORT_KEY,)).fetchone()
    return None if row is None else json.loads(row[0])


def test_grades_only_forward_sessions_that_have_a_following_session(pg_db_conn):
    _seed(pg_db_conn)
    rep = G.run(pg_db_conn, persist=True, protocol=TEST_PROTOCOL)
    assert [x["d"] for x in rep["days"]] == ["2026-11-27", "2026-11-30"]   # 12-01 has no later session yet
    first = rep["days"][0]
    assert first["status"] == "graded" and first["n_up"] == 1 and first["n_other"] == 3
    assert first["D"] == pytest.approx(2.0)
    assert first["drops"]["no_preopen_row"] == 1                            # LATE's 10:30 snapshot is not pre-open
    assert _stored(pg_db_conn)["days"] == rep["days"]


def test_a_graded_day_is_never_recomputed(pg_db_conn):
    _seed(pg_db_conn)
    before = G.run(pg_db_conn, persist=True, protocol=TEST_PROTOCOL)["days"]
    pg_db_conn.execute("UPDATE nse_stocks SET is_asm = 1 WHERE symbol = 'UP'")
    pg_db_conn.execute("UPDATE intraday_ohlcv SET close = 99 WHERE symbol = 'UP'")
    pg_db_conn.commit()
    after = G.run(pg_db_conn, persist=True, protocol=TEST_PROTOCOL)["days"]
    assert after == before


def test_preview_writes_nothing(pg_db_conn):
    _seed(pg_db_conn)
    G.run(pg_db_conn, persist=False, protocol=TEST_PROTOCOL)
    assert _stored(pg_db_conn) is None
    assert pg_db_conn.execute("SELECT count(*) FROM app_settings WHERE key = ?", (G.PROTOCOL_KEY,)).fetchone()[0] == 0


def test_incomplete_bars_leave_the_day_pending_not_graded(pg_db_conn):
    _seed(pg_db_conn)
    pg_db_conn.execute("DELETE FROM intraday_ohlcv WHERE datetime = ?", (dt.datetime(2026, 11, 27, 15, 0, tzinfo=IST),))
    pg_db_conn.commit()
    rep = G.run(pg_db_conn, persist=True, protocol=TEST_PROTOCOL)
    assert [x["d"] for x in rep["days"]] == ["2026-11-30"]
    assert rep["pending"] == [{"d": "2026-11-27", "reason": "bars_incomplete"}]


def test_missing_preopen_day_is_recorded_with_its_reason(pg_db_conn):
    _seed(pg_db_conn)
    pg_db_conn.execute("DELETE FROM preopen_stock_snapshot WHERE snapshot_date = ?", (dt.date(2026, 11, 27),))
    pg_db_conn.commit()
    day = G.run(pg_db_conn, persist=True, protocol=TEST_PROTOCOL)["days"][0]
    assert (day["d"], day["status"], day["reason"]) == ("2026-11-27", "no_d", "no_preopen")


def test_corporate_action_within_one_session_excludes_the_name(pg_db_conn):
    _seed(pg_db_conn)
    pg_db_conn.execute("INSERT INTO corporate_actions (symbol, ex_date, action_type) VALUES ('UP', ?, 'SPLIT')",
                       (dt.date(2026, 11, 30),))
    pg_db_conn.commit()
    days = G.run(pg_db_conn, persist=False, protocol=TEST_PROTOCOL)["days"]
    assert [x["drops"].get("corporate_action", 0) for x in days] == [1, 1]   # the session before and the ex-date


def test_protocol_drift_is_refused(pg_db_conn):
    _seed(pg_db_conn)
    G.run(pg_db_conn, persist=True, protocol=TEST_PROTOCOL)
    with pytest.raises(G.ProtocolDrift):
        G.run(pg_db_conn, persist=True, protocol=dict(TEST_PROTOCOL, gap_threshold_pct=0.5))


def test_frozen_protocol_matches_the_preregistration():
    p = G.PROTOCOL
    assert (p["start_date"], p["gap_threshold_pct"], p["min_adt_cr"], p["verdict_graded_days"], p["t_bar_one_sided"],
            p["min_others"], p["min_symbols"]) == ("2026-11-27", 1.0, 10.0, 150, 1.65, 3, 2000)
