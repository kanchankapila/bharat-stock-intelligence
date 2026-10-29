"""Shadow per-horizon calibrator (AF-20261008-17 / AF-20261001-48).

The live isotonic fit pools the 1/5/15-session outcomes of one signal, so a single number is fitted
to three base rates and each signal counts up to three times. Measured 2026-10-29 on signals since
2026-10-01: calibrated mean 0.40 against realised decisive win rates 0.29/0.20/0.11, Brier worse
than the base rate at every horizon. The shadow fits one calibrator per horizon and writes to its
own table, never to technical_signals, so it can be graded forward before it replaces anything.
"""
import sqlite3

from pg_test_support import pg_memory_conn
from ml_calibration import recalibrate_win_probabilities, shadow_recalibrate_per_horizon


def make_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, win_probability REAL, calibrated_win_probability REAL,
            nifty_regime TEXT, PRIMARY KEY (symbol, date));
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER, outcome TEXT,
            signal_source TEXT NOT NULL DEFAULT 'technical',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source));
    """)
    for p in (0.3, 0.7):
        for i in range(100):
            sym, day = f"S{p}_{i}", f"2026-01-{(i % 28) + 1:02d}"
            conn.execute("INSERT INTO technical_signals (symbol,date,win_probability) VALUES (?,?,?)", (sym, day, p))
            conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,1,?)",
                         (sym, day, 'WIN' if i < 60 else 'LOSS'))
            conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,15,?)",
                         (sym, day, 'WIN' if i < 10 else 'STOP_LOSS'))
    conn.execute("INSERT INTO technical_signals (symbol,date,win_probability) VALUES ('PROBE','2026-02-15',0.7)")
    conn.commit()
    return conn


def shadow(conn):
    return {(r["symbol"], int(r["horizon_days"])): float(r["prob"])
            for r in conn.execute("SELECT symbol, horizon_days, prob FROM calibration_shadow").fetchall()}


def test_each_horizon_gets_its_own_base_rate():
    conn = make_db()
    shadow_recalibrate_per_horizon(conn)
    got = shadow(conn)
    assert abs(got[("PROBE", 1)] - 0.60) < 0.01
    assert abs(got[("PROBE", 15)] - 0.10) < 0.01


def test_only_rows_after_the_fit_window_are_written():
    conn = make_db()
    shadow_recalibrate_per_horizon(conn)
    assert {s for s, _ in shadow(conn)} == {"PROBE"}


def test_never_touches_the_live_column():
    conn = make_db()
    recalibrate_win_probabilities(conn)
    live = conn.execute("SELECT calibrated_win_probability FROM technical_signals WHERE symbol='PROBE'").fetchone()[0]
    shadow_recalibrate_per_horizon(conn)
    assert conn.execute("SELECT calibrated_win_probability FROM technical_signals WHERE symbol='PROBE'").fetchone()[0] == live
    assert abs(live - 0.35) < 0.01  # the pooled live fit lands between the two base rates


def test_rerun_is_idempotent():
    conn = make_db()
    shadow_recalibrate_per_horizon(conn)
    first = shadow(conn)
    shadow_recalibrate_per_horizon(conn)
    assert shadow(conn) == first
