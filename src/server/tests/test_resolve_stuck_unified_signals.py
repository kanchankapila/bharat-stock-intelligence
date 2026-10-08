"""AF-20261008-08: the path-based resolver must record the exit it already found.

`scripts/resolve_stuck_unified_signals.py` is the scheduled `stuck-signal-resolver`. Its
`PLAN_SQL` locates the first OHLCV bar that touches the target or the stop -- so it knows the
exit DATE, the LEVEL touched and the bar's open -- and then wrote only `status`, discarding all
three. Consequence, measured live 2026-10-08: of 58,393 terminal `unified_signals` rows from the
last 45 days, **44,909 carry no `closed_at`, 44,955 no `exit_price` and 44,238 no `exit_reason`**
(43,236 of them `technical`), against 3 for `technical_scan`. A win percentage cannot be computed
from the price a signal actually exited at when the closer that set 96% of those statuses threw
the price away.

The exit-price convention is `signal_lifecycle.close_swing`'s, deliberately, so the two closers
cannot disagree about the same event: the published level, EXCEPT when the bar opened through it,
in which case the fill is the bar's open; and a bar touching BOTH levels books the STOP (a daily
bar does not record intra-bar order, and booking the win would inflate every rate).
"""
import importlib.util
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

_SCRIPT = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', '..',
    'scripts', 'resolve_stuck_unified_signals.py'))


def _load():
    """Load the CLI module without running it (argparse lives inside main())."""
    spec = importlib.util.spec_from_file_location('_stuck_resolver', _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def _signal(conn, symbol, target, stop, entry=100.0, src='technical'):
    conn.execute(
        "INSERT INTO unified_signals (symbol, signal_date, signal_source, signal_type, "
        "entry_price, target_price, stop_loss) VALUES (?, '2026-09-01', ?, 'Bullish', ?, ?, ?)",
        (symbol, src, entry, target, stop))
    conn.commit()
    return conn.execute("SELECT id FROM unified_signals WHERE symbol = ?", (symbol,)).fetchone()[0]


def _bar(conn, symbol, d, o, h, l, c):
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, is_suspect) "
                 "VALUES (?, ?, ?, ?, ?, ?, 0)", (symbol, d, o, h, l, c))
    conn.commit()


def _plan(conn, mod):
    rows = conn.execute(mod.PLAN_SQL.format(age_filter='')).fetchall()
    return {r[1]: r for r in rows}      # keyed by symbol


def _cols(conn, mod):
    """Column names the plan returns, so the assertions below read by name not position."""
    cur = conn.execute(mod.PLAN_SQL.format(age_filter=''))
    return [d[0] for d in cur.description]


class TestPlanReportsTheExitItFound:
    def test_target_touched_reports_target_level_and_date(self, conn):
        mod = _load()
        _signal(conn, 'TGT', target=120.0, stop=90.0)
        _bar(conn, 'TGT', '2026-09-02', 101, 105, 99, 104)       # no touch
        _bar(conn, 'TGT', '2026-09-03', 105, 125, 104, 122)      # high >= 120
        cols = _cols(conn, mod)
        for needed in ('exit_price', 'exit_reason', 'touch_date'):
            assert needed in cols, f"PLAN_SQL must report {needed}; it already knows it"
        r = dict(zip(cols, _plan(conn, mod)['TGT']))
        assert r['new_status'] == 'COMPLETED'
        assert r['exit_reason'] == 'TARGET'
        assert float(r['exit_price']) == 120.0, 'fills at the published level, not the bar close'
        assert str(r['touch_date'])[:10] == '2026-09-03'

    def test_stop_touched_reports_stop_level(self, conn):
        mod = _load()
        _signal(conn, 'STP', target=120.0, stop=90.0)
        _bar(conn, 'STP', '2026-09-02', 99, 101, 85, 88)         # low <= 90
        cols = _cols(conn, mod)
        r = dict(zip(cols, _plan(conn, mod)['STP']))
        assert r['new_status'] == 'FAILED'
        assert r['exit_reason'] == 'STOP'
        assert float(r['exit_price']) == 90.0

    def test_bar_that_GAPS_through_the_stop_fills_at_the_open(self, conn):
        """signal_lifecycle.close_swing's rule: you cannot fill at a level the market opened
        beyond. Without this the resolver books a better price than was available."""
        mod = _load()
        _signal(conn, 'GAPD', target=120.0, stop=90.0)
        _bar(conn, 'GAPD', '2026-09-02', 80, 82, 78, 79)         # opened BELOW the 90 stop
        cols = _cols(conn, mod)
        r = dict(zip(cols, _plan(conn, mod)['GAPD']))
        assert r['new_status'] == 'FAILED'
        assert float(r['exit_price']) == 80.0, 'a gap-through fills at the open, not the stop'

    def test_bar_that_GAPS_through_the_target_fills_at_the_open(self, conn):
        mod = _load()
        _signal(conn, 'GAPU', target=120.0, stop=90.0)
        _bar(conn, 'GAPU', '2026-09-02', 130, 135, 128, 132)     # opened ABOVE the 120 target
        cols = _cols(conn, mod)
        r = dict(zip(cols, _plan(conn, mod)['GAPU']))
        assert r['new_status'] == 'COMPLETED'
        assert float(r['exit_price']) == 130.0

    def test_same_bar_touching_both_books_the_stop_at_the_stop_price(self, conn):
        mod = _load()
        _signal(conn, 'BOTH', target=120.0, stop=90.0)
        _bar(conn, 'BOTH', '2026-09-02', 100, 125, 85, 110)      # touches target AND stop
        cols = _cols(conn, mod)
        r = dict(zip(cols, _plan(conn, mod)['BOTH']))
        assert r['new_status'] == 'FAILED'
        assert r['exit_reason'] == 'STOP'
        assert float(r['exit_price']) == 90.0

    def test_short_signal_stop_is_above_and_fills_at_its_level(self, conn):
        mod = _load()
        # target below stop => short
        _signal(conn, 'SHRT', target=80.0, stop=110.0)
        _bar(conn, 'SHRT', '2026-09-02', 100, 115, 99, 112)      # high >= 110 stop
        cols = _cols(conn, mod)
        r = dict(zip(cols, _plan(conn, mod)['SHRT']))
        assert r['new_status'] == 'FAILED'
        assert r['exit_reason'] == 'STOP'
        assert float(r['exit_price']) == 110.0

    def test_untouched_signal_is_not_in_the_plan(self, conn):
        mod = _load()
        _signal(conn, 'OPEN', target=120.0, stop=90.0)
        _bar(conn, 'OPEN', '2026-09-02', 100, 105, 95, 102)
        assert 'OPEN' not in _plan(conn, mod), 'an untouched signal must stay ACTIVE'


class TestApplyWritesTheExitEvidence:
    def test_update_statement_stamps_all_four_columns(self):
        """Pinned at the source: `status` alone is what produced 44,909 evidence-free terminal
        rows, and a win rate cannot be computed from a price that was never stored."""
        src = open(_SCRIPT, encoding='utf-8').read()
        assert 'closed_at' in src and 'exit_price' in src and 'exit_reason' in src, \
            'the resolver must persist the exit it found, not only the status'
        upd = src[src.index('UPDATE unified_signals SET'):]
        upd = upd[:upd.index('"""') if '"""' in upd[:400] else 400]
        for col in ('status', 'closed_at', 'exit_price', 'exit_reason'):
            assert col in upd, f'{col} missing from the UPDATE'
