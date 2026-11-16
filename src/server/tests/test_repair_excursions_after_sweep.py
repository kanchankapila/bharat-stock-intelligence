"""AF-20261112-12: scripts/repair/repair_excursions_after_sweep.py re-derives signal_excursions rows whose window holds a
bar the bhavcopy sweep replaced, but only rows that the pre-sweep bars reproduce. Real harness on a throwaway schema."""
import csv
import datetime
import importlib.util
import os
import sys

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
SIG = '2026-06-01'


def _load():
    sys.path.insert(0, os.path.join(REPO, 'scripts', 'repair'))
    sys.path.insert(0, os.path.join(REPO, 'src', 'server'))
    path = os.path.join(REPO, 'scripts', 'repair', 'repair_excursions_after_sweep.py')
    spec = importlib.util.spec_from_file_location('repair_excursions_after_sweep', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _days(n):
    d, out = datetime.date(2026, 4, 1), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out


def _bars(base):
    """(date, high, low, close) for 70 sessions: a gentle drift around `base`."""
    return [(d, base * (1.011 + i * 0.0003), base * (0.989 + i * 0.0003), base * (1.0 + i * 0.0003))
            for i, d in enumerate(_days(70))]


@pytest.fixture
def dump(tmp_path):
    p = tmp_path / 'x.dump'
    p.write_bytes(b'PGDMP\x01\x0e\x00' + b'\x00' * 64)
    return str(p)


def _stored(m, bars, hd=5):
    r = m.replay(bars, SIG, hd, 100.0)
    return r


def _insert(conn, sym, hd, r, entry=100.0):
    conn.execute("INSERT INTO signal_excursions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 (sym, SIG, hd, entry, r['mfe_pct'], r['mae_pct'], r['days_to_mfe'], r['days_to_mae'],
                  r['mfe_before_mae'], r['trail_exit_pct'], r['trail_exit_day'], r['horizon_close_pct'], r['atr_pct'],
                  r['tb_label'], r['vol_rank']))


def test_repair_rewrites_only_rows_the_old_bars_reproduce(pg_conn, dump, tmp_path):
    m = _load()
    pg_conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, high REAL, low REAL, close REAL, is_suspect BIGINT)")
    pg_conn.execute("CREATE TABLE signal_excursions (symbol TEXT, signal_date DATE, horizon_days BIGINT, entry_price DOUBLE PRECISION, "
                    "mfe_pct DOUBLE PRECISION, mae_pct DOUBLE PRECISION, days_to_mfe BIGINT, days_to_mae BIGINT, mfe_before_mae BIGINT, "
                    "trail_exit_pct DOUBLE PRECISION, trail_exit_day BIGINT, horizon_close_pct DOUBLE PRECISION, atr_pct DOUBLE PRECISION, "
                    "tb_label BIGINT, vol_rank DOUBLE PRECISION, PRIMARY KEY (symbol, signal_date, horizon_days))")
    days = _days(70)
    swept_day = days[days.index(SIG) + 5]                      # the last bar of the 5-session window after SIG
    snapshots, rows = {}, []
    for sym in ('SWEPT', 'GARBAGE', 'CLEAN'):
        new = _bars(100.0)
        old = [(d, h, l, c) for d, h, l, c in new]
        if sym != 'CLEAN':
            i = days.index(swept_day)
            old[i] = (swept_day, new[i][1] * 0.90, new[i][2] * 1.05, new[i][3] * 0.93)    # the snapshot: narrower range, lower close
        snapshots[sym] = (old, new)
        for d, h, l, c in new:
            pg_conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,0)", (sym, d, h, l, c))
    old_s, new_s = snapshots['SWEPT']
    a, b = m.replay(old_s, SIG, 5, 100.0), m.replay(new_s, SIG, 5, 100.0)
    assert not m.same(a, b), 'fixture: the sweep must move the row, or the test proves nothing'
    _insert(pg_conn, 'SWEPT', 5, a)
    garbage = dict(a); garbage['atr_pct'] = a['atr_pct'] + 3.0; garbage['tb_label'] = 1 - (a['tb_label'] or 0)
    _insert(pg_conn, 'GARBAGE', 5, garbage)                    # produced some other way: must stay exactly as it is
    _insert(pg_conn, 'CLEAN', 5, m.replay(snapshots['CLEAN'][1], SIG, 5, 100.0))   # window holds no swept bar
    pg_conn.commit()
    pre = tmp_path / 'pre.csv'
    with open(pre, 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'])
        for sym in ('SWEPT', 'GARBAGE'):
            i = days.index(swept_day); d, h, l, c = snapshots[sym][0][i]
            w.writerow([sym, d, 100, h, l, c, 1])
    rb = tmp_path / 'rb.csv'
    args = ['--pre-sweep-csv', str(pre), '--rollback-csv', str(rb), '--apply', '--dump-path', dump]
    before_garbage = pg_conn.execute("SELECT atr_pct, tb_label FROM signal_excursions WHERE symbol='GARBAGE'").fetchone()
    assert m.main(args, conn=pg_conn) == 0
    got = pg_conn.execute("SELECT mfe_pct, mae_pct, horizon_close_pct, atr_pct, tb_label FROM signal_excursions WHERE symbol='SWEPT'").fetchone()
    assert abs(got[0] - b['mfe_pct']) < 1e-9 and abs(got[2] - b['horizon_close_pct']) < 1e-9 and got[4] == b['tb_label']
    assert (got[0], got[2]) != (a['mfe_pct'], a['horizon_close_pct'])                 # really moved
    assert tuple(pg_conn.execute("SELECT atr_pct, tb_label FROM signal_excursions WHERE symbol='GARBAGE'").fetchone()) == tuple(before_garbage)
    rows = list(csv.DictReader(open(rb)))
    assert [r['symbol'] for r in rows] == ['SWEPT'] and abs(float(rows[0]['mfe_pct']) - a['mfe_pct']) < 1e-9   # pre-state saved
    assert m.main(args, conn=pg_conn) == 0                                            # idempotent
    assert pg_conn.execute("SELECT mfe_pct FROM signal_excursions WHERE symbol='SWEPT'").fetchone()[0] == got[0]


def test_same_treats_none_and_tolerance():
    m = _load()
    assert m.same({'mfe_pct': 1.0, 'tb_label': None}, {'mfe_pct': 1.0 + 1e-6, 'tb_label': None})
    assert not m.same({'tb_label': None}, {'tb_label': 0})
    assert not m.same({'mfe_pct': 1.0}, {'mfe_pct': 1.01})


def test_update_skips_a_row_that_changed_after_the_plan(pg_conn, tmp_path):
    m = _load()
    pg_conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, high REAL, low REAL, close REAL, is_suspect BIGINT)")
    pg_conn.execute("CREATE TABLE signal_excursions (symbol TEXT, signal_date DATE, horizon_days BIGINT, entry_price DOUBLE PRECISION, "
                    "mfe_pct DOUBLE PRECISION, mae_pct DOUBLE PRECISION, days_to_mfe BIGINT, days_to_mae BIGINT, mfe_before_mae BIGINT, "
                    "trail_exit_pct DOUBLE PRECISION, trail_exit_day BIGINT, horizon_close_pct DOUBLE PRECISION, atr_pct DOUBLE PRECISION, "
                    "tb_label BIGINT, vol_rank DOUBLE PRECISION, PRIMARY KEY (symbol, signal_date, horizon_days))")
    days = _days(70)
    swept_day = days[days.index(SIG) + 5]
    new = _bars(100.0)
    old = list(new)
    i = days.index(swept_day)
    old[i] = (swept_day, new[i][1] * 0.90, new[i][2] * 1.05, new[i][3] * 0.93)
    for d, h, l, c in new:
        pg_conn.execute("INSERT INTO stock_ohlcv VALUES ('S',?,?,?,?,0)", (d, h, l, c))
    _insert(pg_conn, 'S', 5, m.replay(old, SIG, 5, 100.0))
    pg_conn.commit()
    pre = tmp_path / 'pre.csv'
    with open(pre, 'w', newline='') as f:
        w = csv.writer(f); w.writerow(['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'])
        d, h, l, c = old[i]; w.writerow(['S', d, 100, h, l, c, 1])
    ops, _ = m.plan(pg_conn, str(pre))
    assert len(ops) == 1 and pg_conn.execute(ops[0].count_sql, ops[0].params).fetchall()[0][0] == 1
    pg_conn.execute("UPDATE signal_excursions SET tb_label = 1 - COALESCE(tb_label, 0), atr_pct = atr_pct + 1")   # another writer got there first
    pg_conn.commit()
    changed = tuple(pg_conn.execute("SELECT atr_pct, tb_label FROM signal_excursions").fetchone())
    assert pg_conn.execute(ops[0].apply_sql, ops[0].params).rowcount == 0
    assert tuple(pg_conn.execute("SELECT atr_pct, tb_label FROM signal_excursions").fetchone()) == changed
