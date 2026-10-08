"""AF-20261008-08 (repair half): stamp the exit on rows closed before the resolver recorded one.

Fixing the writer does not clean the rows the bug already wrote (recurring-bugs.md). 44,909
terminal `unified_signals` rows inside the trailing 45-day window carry a COMPLETED/FAILED/EXPIRED
status with no `closed_at`, `exit_price` or `exit_reason`, so no win rate over them can use the
price the signal actually exited at.

Re-deriving the first touch from OHLCV reproduces the STORED status for 44,211 of 44,238 rows
(99.94%, measured live 2026-10-08) -- those statuses came from the same path-based logic -- so
stamping the evidence where the two agree is a pure repair and re-grades nothing. The 27
disagreements are left ALONE and reported: changing a stored verdict is a different decision from
recording the evidence for it.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
from data_integrity_repair import repair_signal_exit_evidence  # noqa: E402


@pytest.fixture
def conn():
    c = pg_memory_conn()
    c.executescript('''
        CREATE TABLE unified_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, signal_date TIMESTAMPTZ, signal_source TEXT, signal_type TEXT,
            entry_price REAL, target_price REAL, stop_loss REAL,
            status TEXT DEFAULT 'ACTIVE', closed_at DATE, exit_price REAL, exit_reason TEXT,
            signal_generated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT NOT NULL, date DATE NOT NULL,
            open REAL, high REAL, low REAL, close REAL, is_suspect INTEGER,
            PRIMARY KEY (symbol, date)
        );
    ''')
    return c


def _sig(conn, symbol, status, target=120.0, stop=90.0, src='technical', days_ago=10):
    conn.execute(
        "INSERT INTO unified_signals (symbol, signal_date, signal_source, signal_type, "
        "entry_price, target_price, stop_loss, status) "
        "VALUES (?, NOW() - (? * INTERVAL '1 day'), ?, 'Bullish', 100.0, ?, ?, ?)",
        (symbol, days_ago, src, target, stop, status))
    conn.commit()


def _bar(conn, symbol, days_ago, o, h, l, c):
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, is_suspect) "
                 "VALUES (?, (NOW() - (? * INTERVAL '1 day'))::date, ?, ?, ?, ?, 0)",
                 (symbol, days_ago, o, h, l, c))
    conn.commit()


def _row(conn, symbol):
    return conn.execute(
        "SELECT status, closed_at, exit_price, exit_reason FROM unified_signals WHERE symbol = ?",
        (symbol,)).fetchone()


class TestRepairStampsAgreeingRows:
    def test_completed_row_gets_its_target_fill(self, conn):
        _sig(conn, 'OK', 'COMPLETED')
        _bar(conn, 'OK', 8, 101, 125, 100, 122)        # high >= 120 target
        repair_signal_exit_evidence(conn, dry=False)
        r = _row(conn, 'OK')
        assert r['status'] == 'COMPLETED', 'a pure repair must not change the stored verdict'
        assert float(r['exit_price']) == 120.0
        assert r['exit_reason'] == 'TARGET'
        assert r['closed_at'] is not None

    def test_failed_row_gets_its_stop_fill(self, conn):
        _sig(conn, 'BAD', 'FAILED')
        _bar(conn, 'BAD', 8, 99, 101, 85, 88)          # low <= 90 stop
        repair_signal_exit_evidence(conn, dry=False)
        r = _row(conn, 'BAD')
        assert r['status'] == 'FAILED'
        assert float(r['exit_price']) == 90.0
        assert r['exit_reason'] == 'STOP'

    def test_gap_through_the_stop_fills_at_the_open(self, conn):
        _sig(conn, 'GAP', 'FAILED')
        _bar(conn, 'GAP', 8, 80, 82, 78, 79)           # opened below the stop
        repair_signal_exit_evidence(conn, dry=False)
        assert float(_row(conn, 'GAP')['exit_price']) == 80.0


class TestRepairNeverRegrades:
    def test_disagreeing_row_is_left_untouched(self, conn):
        """Stored FAILED but the bars say the target came first: recording evidence for a verdict
        is not the same decision as changing it. Leave it, and report it."""
        _sig(conn, 'DISAGREE', 'FAILED')
        _bar(conn, 'DISAGREE', 8, 101, 125, 100, 122)  # target touched, no stop touch
        repair_signal_exit_evidence(conn, dry=False)
        r = _row(conn, 'DISAGREE')
        assert r['status'] == 'FAILED'
        assert r['exit_price'] is None, 'a disagreeing row must not be stamped'
        assert r['closed_at'] is None

    def test_rows_that_already_have_evidence_are_not_rewritten(self, conn):
        _sig(conn, 'DONE', 'COMPLETED')
        conn.execute("UPDATE unified_signals SET closed_at = '2026-01-01', exit_price = 111.0, "
                     "exit_reason = 'TARGET' WHERE symbol = 'DONE'")
        conn.commit()
        _bar(conn, 'DONE', 8, 101, 125, 100, 122)
        repair_signal_exit_evidence(conn, dry=False)
        assert float(_row(conn, 'DONE')['exit_price']) == 111.0

    def test_active_rows_are_never_touched(self, conn):
        _sig(conn, 'LIVE', 'ACTIVE')
        _bar(conn, 'LIVE', 8, 101, 125, 100, 122)
        repair_signal_exit_evidence(conn, dry=False)
        r = _row(conn, 'LIVE')
        assert r['status'] == 'ACTIVE' and r['exit_price'] is None, \
            'closing a live signal is signal_lifecycle.py\'s job, not a repair\'s'

    def test_dry_run_writes_nothing(self, conn):
        _sig(conn, 'DRY', 'COMPLETED')
        _bar(conn, 'DRY', 8, 101, 125, 100, 122)
        repair_signal_exit_evidence(conn, dry=True)
        assert _row(conn, 'DRY')['exit_price'] is None


class TestExpiredRowsExitAtTheirLastSessionClose:
    """The user-visible half: an EXPIRED signal did not fail, it ran out of time -- so its return
    must be measured at the price it actually exited at, which is the close of the last session in
    its own window, not its entry and not a stop it never touched."""

    def test_expired_row_exits_at_the_window_last_close(self, conn):
        _sig(conn, 'TIME', 'EXPIRED', days_ago=30)
        for ago, px in ((28, 104.0), (27, 103.0), (26, 102.5)):
            _bar(conn, 'TIME', ago, 101, 105, 100, px)   # never touches 120 or 90
        repair_signal_exit_evidence(conn, dry=False)
        r = _row(conn, 'TIME')
        assert r['exit_reason'] == 'TIME_EXIT'
        assert float(r['exit_price']) == 102.5, 'exits at the last clean close in its window'
        assert r['closed_at'] is not None

    def test_a_touch_AFTER_the_window_does_not_block_the_time_exit(self, conn):
        """Regression for a bug the first implementation shipped and only the live dry run caught:
        the touch test was written as `bool_or(...) OVER ()` beside `ORDER BY date LIMIT horizon`,
        and Postgres evaluates a window function BEFORE ORDER BY/LIMIT at the same query level --
        so it scanned the whole post-signal history instead of the signal's own window. Every
        EXPIRED row then looked as if it had touched a level and 0 of 621 were priced, while this
        suite stayed green because its fixtures had no bars outside the window.

        A level touched AFTER the window has elapsed is irrelevant: the signal had already
        expired. The window is 15 sessions here (source 'technical')."""
        _sig(conn, 'LATE', 'EXPIRED', days_ago=40)
        for ago in range(39, 24, -1):                     # 15 quiet bars inside the window
            _bar(conn, 'LATE', ago, 101, 105, 100, 102.0)
        _bar(conn, 'LATE', 20, 118, 130, 117, 128)        # a target touch well AFTER the window
        repair_signal_exit_evidence(conn, dry=False)
        r = _row(conn, 'LATE')
        assert r['exit_reason'] == 'TIME_EXIT', \
            'a touch outside the validity window must not suppress the time exit'
        assert float(r['exit_price']) == 102.0

    def test_expired_row_whose_levels_were_touched_is_left_alone(self, conn):
        """If the bars say a level was touched, EXPIRED is the wrong verdict and this repair does
        not silently convert it -- same no-regrading rule as above."""
        _sig(conn, 'ODD', 'EXPIRED', days_ago=30)
        _bar(conn, 'ODD', 28, 101, 125, 100, 122)
        repair_signal_exit_evidence(conn, dry=False)
        assert _row(conn, 'ODD')['exit_price'] is None
