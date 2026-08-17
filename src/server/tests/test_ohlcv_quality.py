import sys, os, sqlite3
import pandas as pd
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

from ohlcv_quality import (  # noqa: E402
    parse_split_actions,
    parse_dividend_actions,
    is_bad_print,
    flag_bad_prints,
)


# ── corporate-action parsing (allowlist source) ─────────────────────────────────

def test_parse_split_actions():
    s = pd.Series({pd.Timestamp('2024-06-01'): 5.0})
    assert parse_split_actions(s) == [('2024-06-01', 5.0)]


def test_parse_split_actions_skips_zero_nan():
    s = pd.Series({pd.Timestamp('2024-06-01'): 0.0, pd.Timestamp('2024-07-01'): float('nan')})
    assert parse_split_actions(s) == []


def test_parse_dividend_actions():
    s = pd.Series({pd.Timestamp('2024-03-15'): 9.0})
    assert parse_dividend_actions(s) == [('2024-03-15', 9.0)]


# ── bad-print detection (spike = deviates from BOTH neighbours) ──────────────────

def test_single_bar_spike_up_is_bad():
    # 34 -> 907 -> 34 : a one-bar error, not a real move
    assert is_bad_print(prev_close=34, cur_close=907, next_close=34) is True


def test_single_bar_spike_down_is_bad():
    assert is_bad_print(prev_close=34, cur_close=3.43, next_close=34) is True


def test_genuine_level_shift_is_not_a_spike():
    # a real step up that persists (deviates from prev but NOT from next) — keep it
    assert is_bad_print(prev_close=100, cur_close=200, next_close=200) is False


def test_normal_bar_is_not_bad():
    assert is_bad_print(prev_close=100, cur_close=103, next_close=105) is False


def test_known_corporate_action_suppresses_flag():
    # even a spike-shaped move is left alone if a corporate action explains it
    assert is_bad_print(prev_close=34, cur_close=907, next_close=34, near_known_action=True) is False


def test_boundary_bar_without_a_neighbour_is_not_flagged():
    assert is_bad_print(prev_close=None, cur_close=907, next_close=34) is False
    assert is_bad_print(prev_close=34, cur_close=907, next_close=None) is False


# ── integration: flag suspect bars in stock_ohlcv ───────────────────────────────

def make_db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER,
            is_suspect INTEGER DEFAULT 0, PRIMARY KEY (symbol, date)
        );
        CREATE TABLE corporate_actions (
            symbol TEXT, ex_date TEXT, action_type TEXT, ratio REAL, amount REAL,
            PRIMARY KEY (symbol, ex_date, action_type)
        );
    """)
    return conn


def _bars(conn, symbol, closes, start='2024-01-01'):
    d = pd.Timestamp(start)
    for i, c in enumerate(closes):
        day = (d + pd.Timedelta(days=i)).date().isoformat()
        conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,100)",
                     (symbol, day, c, c, c, c))


def test_flag_bad_prints_marks_spikes_only():
    conn = make_db()
    _bars(conn, 'SPIKE', [100, 100, 700, 100, 100])   # the 700 bar is a one-day error
    _bars(conn, 'CLEAN', [100, 101, 102, 103, 104])    # no spikes
    conn.commit()

    flag_bad_prints(conn)

    suspect = conn.execute("SELECT symbol, close FROM stock_ohlcv WHERE is_suspect=1").fetchall()
    assert suspect == [('SPIKE', 700.0)]


def test_flag_bad_prints_respects_corporate_action_allowlist():
    conn = make_db()
    _bars(conn, 'CORP', [100, 100, 700, 700, 700])     # a real step up at a split ex-date
    # an action near the jump date (index 2 -> 2024-01-03) suppresses any flag there
    conn.execute("INSERT INTO corporate_actions VALUES ('CORP','2024-01-03','SPLIT',0.143,NULL)")
    _bars(conn, 'BAD', [100, 100, 700, 100, 100])      # genuine spike, no action
    conn.commit()

    flag_bad_prints(conn)

    flagged = {r[0] for r in conn.execute("SELECT DISTINCT symbol FROM stock_ohlcv WHERE is_suspect=1").fetchall()}
    assert 'BAD' in flagged
    assert 'CORP' not in flagged
