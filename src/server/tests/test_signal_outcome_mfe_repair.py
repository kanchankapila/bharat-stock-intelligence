"""Regression tests for the formerly unwritten signal_outcomes.max_return_pct field."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import data_integrity_repair as repair  # noqa: E402
from pg_test_support import pg_memory_conn  # noqa: E402


def _conn():
    conn = pg_memory_conn()
    conn.execute("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date DATE, horizon_days INTEGER, signal_source TEXT,
            entry_price DOUBLE PRECISION, check_date DATE, max_return_pct DOUBLE PRECISION,
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
        )
    """)
    conn.execute("""
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, high DOUBLE PRECISION,
            is_suspect SMALLINT DEFAULT 0, PRIMARY KEY (symbol, date)
        )
    """)
    conn.commit()
    return conn


def test_backfill_stops_at_actual_exit_and_ignores_suspect_bars():
    conn = _conn()
    conn.execute("INSERT INTO signal_outcomes VALUES ('A','2026-10-01',5,'technical',100,'2026-10-03',NULL)")
    conn.executemany("INSERT INTO stock_ohlcv VALUES (?,?,?,?)", [
        ('A', '2026-10-02', 110, 0),
        ('A', '2026-10-03', 130, 1),  # bad print: excluded
        ('A', '2026-10-04', 150, 0),  # after exit: excluded
    ])
    conn.commit()

    repair.repair_signal_outcome_mfe(conn, dry=False)
    value = conn.execute("SELECT max_return_pct FROM signal_outcomes WHERE symbol='A'").fetchone()[0]
    assert value == pytest.approx(10.0)


def test_dry_run_does_not_write():
    conn = _conn()
    conn.execute("INSERT INTO signal_outcomes VALUES ('A','2026-10-01',5,'technical',100,'2026-10-02',NULL)")
    conn.execute("INSERT INTO stock_ohlcv VALUES ('A','2026-10-02',110,0)")
    conn.commit()

    repair.repair_signal_outcome_mfe(conn, dry=True)
    assert conn.execute("SELECT max_return_pct FROM signal_outcomes").fetchone()[0] is None
