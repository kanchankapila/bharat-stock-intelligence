"""AF-20261112-12: scripts/repair/regrade_outcomes_after_sweep.py re-grades outcome rows through the resolver's own
grading (`keys=` / `sink=`), and rewrites only rows that a replay on the pre-sweep bars reproduces."""
import csv
import datetime
import importlib.util
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SIGNAL_DATE = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
EXIT_DATE = (datetime.date.today() - datetime.timedelta(days=39)).isoformat()
OLD = (100.0, 100.3, 99.9, 100.2, 50000)          # the partial-day snapshot: open, high, low, close, volume
NEW = (100.0, 111.0, 99.9, 110.0, 100000)         # the official bar


def _load():
    sys.path.insert(0, os.path.join(REPO, 'scripts', 'repair'))
    path = os.path.join(REPO, 'scripts', 'repair', 'regrade_outcomes_after_sweep.py')
    spec = importlib.util.spec_from_file_location('regrade_outcomes_after_sweep', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE technical_signals (symbol TEXT, date DATE, cmp REAL, signal_score INTEGER, signals_json TEXT,
            stop_loss TEXT, time_horizon TEXT, PRIMARY KEY (symbol, date));
        CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open REAL, high REAL, low REAL, close REAL, volume INTEGER,
            is_suspect INTEGER DEFAULT 0, PRIMARY KEY (symbol, date));
        CREATE TABLE signal_outcomes (symbol TEXT, signal_date DATE, horizon_days INTEGER, entry_price REAL, check_date DATE,
            exit_price REAL, return_pct REAL, outcome TEXT, signal_score INTEGER, signals_json TEXT, max_return_pct REAL,
            computed_at TEXT, label_definition TEXT, signal_source TEXT NOT NULL DEFAULT 'unknown',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source));
        CREATE TABLE unified_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, signal_date TEXT, entry_price REAL,
            target_price REAL, stop_loss REAL, signal_source TEXT, confidence_score REAL, status TEXT DEFAULT 'ACTIVE');
        CREATE TABLE unified_signal_outcomes (unified_signal_id INTEGER, signal_source TEXT, symbol TEXT, signal_date DATE,
            horizon_days INTEGER, entry_price REAL, entry_time TEXT, check_date DATE, exit_price REAL, outcome TEXT,
            return_pct REAL, exit_reason TEXT, signal_score INTEGER, intraday_max_return_pct REAL,
            intraday_min_return_pct REAL, exit_time TEXT, computed_at TEXT, PRIMARY KEY (unified_signal_id, horizon_days));
    """)
    return conn


def _bars(conn, sym, exit_bar):
    d = datetime.date.fromisoformat(SIGNAL_DATE)
    for i in range(15, 0, -1):
        conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,100,100,100,100,100000)",
                     (sym, (d - datetime.timedelta(days=i)).isoformat()))
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)",
                 (sym, SIGNAL_DATE, 100, 100, 100, 100, 100000))
    conn.execute("INSERT INTO stock_ohlcv (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)",
                 (sym, EXIT_DATE) + exit_bar)


@pytest.fixture
def dump(tmp_path):
    p = tmp_path / 'x.dump'
    p.write_bytes(b'PGDMP\x01\x0e\x00' + b'\x00' * 64)
    return str(p)


@pytest.fixture
def world(tmp_path):
    """TSWEPT/USWEPT graded on the snapshot then swept; TGARB the same but its stored grade came from elsewhere;
    TCLEAN has no swept bar."""
    from outcome_resolver import resolve_outcomes, resolve_unified_outcomes
    conn = _db()
    for s in ('TSWEPT', 'TGARB', 'USWEPT'):
        _bars(conn, s, OLD)
    _bars(conn, 'TCLEAN', NEW)
    for s in ('TSWEPT', 'TGARB', 'TCLEAN'):
        conn.execute("INSERT INTO technical_signals VALUES (?,?,100.0,6,'[]',NULL,'1 day')", (s, SIGNAL_DATE))
    conn.execute("INSERT INTO unified_signals (symbol,signal_date,entry_price,target_price,stop_loss,signal_source,confidence_score) "
                 "VALUES ('USWEPT',?,NULL,110,90,'AI',75)", (SIGNAL_DATE,))
    conn.commit()
    resolve_outcomes(conn, horizon_days=1)
    resolve_unified_outcomes(conn, horizon_days=1)
    assert conn.execute("SELECT outcome FROM signal_outcomes WHERE symbol='TSWEPT'").fetchone()[0] == 'NEUTRAL'
    conn.execute("UPDATE signal_outcomes SET outcome = 'LOSS', return_pct = -3.0 WHERE symbol = 'TGARB'")
    conn.execute("UPDATE stock_ohlcv SET high = ?, close = ?, volume = ? WHERE symbol IN ('TSWEPT','TGARB','USWEPT') AND date = ?",
                 (NEW[1], NEW[3], NEW[4], EXIT_DATE))
    conn.commit()
    pre = tmp_path / 'pre.csv'
    with open(pre, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'])
        for s in ('TSWEPT', 'TGARB', 'USWEPT'):
            w.writerow([s, EXIT_DATE] + list(OLD))
    return conn, str(pre), str(tmp_path / 'rb')


def _outcome(conn, table, sym, col='outcome'):
    return conn.execute(f"SELECT {col} FROM {table} WHERE symbol = ?", (sym,)).fetchone()[0]


def test_regrade_rewrites_only_rows_the_pre_sweep_bars_reproduce(world, dump, capsys):
    m = _load()
    conn, pre, rb = world
    args = ['--pre-sweep-csv', pre, '--rollback-prefix', rb, '--apply', '--dump-path', dump]
    assert m.main(args, conn=conn) == 0
    assert _outcome(conn, 'signal_outcomes', 'TSWEPT') == 'WIN'
    assert _outcome(conn, 'signal_outcomes', 'TSWEPT', 'exit_price') == 110.0
    assert _outcome(conn, 'signal_outcomes', 'TGARB') == 'LOSS'                 # not reproducible: untouched
    assert _outcome(conn, 'signal_outcomes', 'TCLEAN') == 'WIN'
    assert _outcome(conn, 'unified_signal_outcomes', 'USWEPT') == 'WIN'
    assert _outcome(conn, 'unified_signal_outcomes', 'USWEPT', 'exit_reason') != 'HORIZON'
    saved = list(csv.DictReader(open(f'{rb}_signal_outcomes.csv')))
    assert [r['symbol'] for r in saved] == ['TSWEPT'] and saved[0]['outcome'] == 'NEUTRAL'     # pre-state kept
    assert [r['outcome'] for r in csv.DictReader(open(f'{rb}_unified_signal_outcomes.csv'))] == ['NEUTRAL']
    capsys.readouterr()
    assert m.main(['--pre-sweep-csv', pre], conn=conn) == 0                     # a second dry-run plans nothing
    out = capsys.readouterr().out
    assert 'signal_outcomes: to update 0 rows' in out and 'unified_signal_outcomes: to update 0 rows' in out


def test_update_skips_a_row_that_changed_after_the_plan(world):
    m = _load()
    conn, pre, _ = world
    ops, _ = m.plan(conn, pre)
    op = [o for o in ops if o.label == 'signal_outcomes'][0]
    assert conn.execute(op.count_sql, op.params).fetchall()[0][0] == 1
    conn.execute("UPDATE signal_outcomes SET return_pct = 9.9 WHERE symbol = 'TSWEPT'")     # another writer got there first
    conn.commit()
    assert conn.execute(op.apply_sql, op.params).rowcount == 0
    assert _outcome(conn, 'signal_outcomes', 'TSWEPT', 'return_pct') == 9.9


def test_the_shadow_table_is_gone_after_planning(world):
    m = _load()
    conn, pre, _ = world
    m.plan(conn, pre)
    assert conn.execute("SELECT count(*) FROM pg_class WHERE relname = 'stock_ohlcv' AND relpersistence = 't'").fetchone()[0] == 0
    assert conn.execute("SELECT close FROM stock_ohlcv WHERE symbol = 'TSWEPT' AND date = ?", (EXIT_DATE,)).fetchone()[0] == NEW[3]


def test_keys_mode_grades_an_already_resolved_row_and_writes_nothing(world):
    import outcome_resolver as R
    conn, _, _ = world
    sink = []
    R._resolve_outcomes_batch(conn, horizon_days=1, keys=[('TSWEPT', SIGNAL_DATE)], sink=sink)
    assert len(sink) == 1 and sink[0][7] == 'WIN'                               # regraded on the current bar
    assert _outcome(conn, 'signal_outcomes', 'TSWEPT') == 'NEUTRAL'             # nothing written
    usink = []
    uid = conn.execute("SELECT id FROM unified_signals WHERE symbol = 'USWEPT'").fetchone()[0]
    R._resolve_unified_batch(conn, horizon_days=1, keys=[uid], sink=usink)
    assert len(usink) == 1 and usink[0][8] == 'WIN'
    assert _outcome(conn, 'unified_signal_outcomes', 'USWEPT') == 'NEUTRAL'
