"""AF-20261001-37: unified_signals had no closer. updateSignalAccuracy (signals.ts) -- the only
code that moved status off ACTIVE -- had zero callers since the initial commit; every
COMPLETED/FAILED row came from one-off manual backfills with no validity window. Live 2026-10-01:
technical 90,755 ACTIVE back to 2026-06-19, screener (an INTRADAY scan) 2,443 ACTIVE back to
2026-06-30. signal_lifecycle closes each signal at target (COMPLETED), stop (FAILED) or the end
of its validity window (EXPIRED), recording the date, price and reason."""
import os
import sys
import datetime as dt

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
import signal_lifecycle as sl  # noqa: E402

D = dt.date(2026, 9, 1)


def bar(i, o, h, l, c):
    return ((D + dt.timedelta(days=i)).isoformat(), o, h, l, c)


class TestCloseSwing:
    def test_target_first_completes_at_target(self):
        r = sl.close_swing([bar(1, 100, 104, 99, 103), bar(2, 103, 111, 102, 110)], 100, 110, 95, True)
        assert r == ('COMPLETED', bar(2, 0, 0, 0, 0)[0], 110, 'TARGET')

    def test_stop_first_fails_at_stop(self):
        r = sl.close_swing([bar(1, 100, 101, 94, 96), bar(2, 96, 112, 95, 111)], 100, 110, 95, True)
        assert r[:2] == ('FAILED', bar(1, 0, 0, 0, 0)[0]) and r[2] == 95

    def test_both_levels_in_one_daily_bar_is_a_stop(self):
        assert sl.close_swing([bar(1, 100, 111, 94, 100)], 100, 110, 95, True)[0] == 'FAILED'

    def test_gap_through_stop_fills_at_the_open(self):
        assert sl.close_swing([bar(1, 90, 92, 89, 91)], 100, 110, 95, True)[2] == 90

    def test_short_geometry(self):
        r = sl.close_swing([bar(1, 100, 101, 89, 90)], 100, 90, 105, True)
        assert r[0] == 'COMPLETED' and r[2] == 90

    def test_no_touch_in_a_complete_window_expires_at_last_close(self):
        r = sl.close_swing([bar(1, 100, 102, 99, 101), bar(2, 101, 103, 100, 102)], 100, 110, 95, True)
        assert r == ('EXPIRED', bar(2, 0, 0, 0, 0)[0], 102, 'TIME_EXIT')

    def test_no_touch_in_an_open_window_stays_active(self):
        assert sl.close_swing([bar(1, 100, 102, 99, 101)], 100, 110, 95, False) is None

    def test_stop_only_signal_can_fail_or_expire(self):
        assert sl.close_swing([bar(1, 100, 101, 94, 96)], 100, None, 95, True)[0] == 'FAILED'
        assert sl.close_swing([bar(1, 100, 101, 99, 100)], 100, None, 95, True)[0] == 'EXPIRED'


def _db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE unified_signals (id INTEGER PRIMARY KEY, symbol TEXT, signal_date TIMESTAMPTZ,
            signal_generated_at TIMESTAMPTZ, signal_source TEXT, signal_type TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL, status TEXT,
            horizon_sessions SMALLINT, closed_at DATE, exit_price DOUBLE PRECISION, exit_reason TEXT);
        CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open REAL, high REAL, low REAL, close REAL,
            is_suspect INTEGER DEFAULT 0);
        CREATE TABLE intraday_ohlcv (symbol TEXT, datetime TIMESTAMPTZ, interval TEXT,
            open REAL, high REAL, low REAL, close REAL);
        CREATE TABLE recommendation_log (id INTEGER PRIMARY KEY, symbol TEXT, signal_date DATE,
            horizon_days INTEGER, outcome TEXT, status TEXT);
    """)
    return conn


def _weekdays(start, n):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def test_run_closes_swing_signals_by_their_source_window_and_stamps_horizon():
    conn = _db()
    days = _weekdays(dt.date(2026, 8, 3), 25)
    for d in days:
        for sym in ('FLAT', 'HIT'):
            hi = 120 if (sym == 'HIT' and d == days[3]) else 101
            conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,100,?,99,100,0)", (sym, d.isoformat(), hi))
    sig = days[0].isoformat() + ' 18:00:00+05:30'
    conn.execute("INSERT INTO unified_signals (id,symbol,signal_date,signal_generated_at,signal_source,"
                 "signal_type,entry_price,target_price,stop_loss,status) VALUES "
                 "(1,'FLAT',?,?,'technical_scan','BUY',100,110,95,'ACTIVE'),"
                 "(2,'HIT',?,?,'technical','Bullish',100,110,95,'ACTIVE'),"
                 "(3,'FLAT',?,?,'technical','Bullish',100,110,95,'INVALIDATED_CONFLICT')",
                 (sig, sig, sig, sig, sig, sig))
    conn.commit()
    sl.run(conn)
    got = {r[0]: tuple(r)[1:] for r in conn.execute(
        "SELECT id, status, closed_at::text, exit_price, exit_reason, horizon_sessions "
        "FROM unified_signals ORDER BY id").fetchall()}
    # technical_scan: 5-session validity, no touch -> EXPIRED at the 5th session's close
    assert got[1] == ('EXPIRED', days[5].isoformat(), 100.0, 'TIME_EXIT', 5)
    # technical: target touched on the 3rd session after the signal
    assert got[2] == ('COMPLETED', days[3].isoformat(), 110.0, 'TARGET', 15)
    assert got[3][0] == 'INVALIDATED_CONFLICT'


def test_intraday_screener_signal_closes_within_its_own_session():
    conn = _db()
    day = dt.date(2026, 9, 1)  # a Tuesday
    nxt = dt.date(2026, 9, 2)
    for d in (day, nxt):
        conn.execute("INSERT INTO stock_ohlcv VALUES ('SCR',?,100,101,99,100,0)", (d.isoformat(),))
    ist = dt.timezone(dt.timedelta(hours=5, minutes=30))
    t = dt.datetime(2026, 9, 1, 9, 15, tzinfo=ist)
    while t.hour < 15 or (t.hour == 15 and t.minute <= 15):
        hi = 106 if (t.hour, t.minute) == (13, 0) else 101
        conn.execute("INSERT INTO intraday_ohlcv VALUES ('SCR',?,'15m',100,?,99.5,100.5)", (t.isoformat(), hi))
        t += dt.timedelta(minutes=15)
    conn.execute("INSERT INTO unified_signals (id,symbol,signal_date,signal_generated_at,signal_source,"
                 "signal_type,entry_price,target_price,stop_loss,status) VALUES "
                 "(1,'SCR','2026-09-01',?,'screener','BUY',100,105,97,'ACTIVE')",
                 (dt.datetime(2026, 9, 1, 11, 2, tzinfo=ist).isoformat(),))
    conn.commit()
    sl.run(conn)
    r = conn.execute("SELECT status, closed_at::text, exit_price, exit_reason, horizon_sessions "
                     "FROM unified_signals").fetchone()
    assert tuple(r) == ('COMPLETED', '2026-09-01', 105.0, 'TARGET', 0)


def test_migration_adds_the_lifecycle_columns_idempotently():
    path = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'migrations',
                        '20261001120000_unified-signals-lifecycle.sql')
    with open(path, encoding='utf-8') as f:
        sql = f.read()
    conn = pg_memory_conn()
    conn.execute("CREATE TABLE unified_signals (id INTEGER PRIMARY KEY, symbol TEXT, status TEXT)")
    conn.executescript(sql)
    conn.executescript(sql)
    cols = {r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'unified_signals' "
        "AND table_schema = current_schema()").fetchall()}
    assert {'horizon_sessions', 'closed_at', 'exit_price', 'exit_reason'} <= cols


def test_recommendation_log_rows_past_their_horizon_stop_being_active():
    """AF-20261001-37 (same no-closer class): 21,638 recommendation_log rows sat ACTIVE on
    2026-10-01, the oldest from 2026-05-18 at horizon 15 -- and trailingStopUpdater ratchets a
    stop on every ACTIVE BUY each run, as if a May recommendation were still an open position."""
    conn = _db()
    days = _weekdays(dt.date(2026, 8, 3), 25)
    for d in days:
        conn.execute("INSERT INTO stock_ohlcv VALUES ('MKT',?,100,101,99,100,0)", (d.isoformat(),))
    conn.execute("INSERT INTO recommendation_log VALUES "
                 "(1,'OLD',?,15,NULL,'ACTIVE'),"       # horizon elapsed -> EXPIRED
                 "(2,'NEW',?,15,NULL,'ACTIVE'),"       # still inside its window -> ACTIVE
                 "(3,'SHORT',?,5,NULL,'ACTIVE')",      # 5-session horizon elapsed -> EXPIRED
                 (days[0].isoformat(), days[-3].isoformat(), days[-8].isoformat()))
    conn.commit()
    assert sl.expire_stale_recommendations(conn, dry_run=True) == 2
    assert {r[0]: r[1] for r in conn.execute(
        "SELECT id, status FROM recommendation_log").fetchall()} == {
        1: 'ACTIVE', 2: 'ACTIVE', 3: 'ACTIVE'}, "dry run must not write"
    assert sl.expire_stale_recommendations(conn) == 2
    assert {r[0]: r[1] for r in conn.execute(
        "SELECT id, status FROM recommendation_log").fetchall()} == {
        1: 'EXPIRED', 2: 'ACTIVE', 3: 'EXPIRED'}
