"""AF-20261008-37: scripts/repair/repair_unadjusted_splits.py back-adjusts stock_ohlcv bars left
on the pre-split basis, once, and only where a factor's seam is still visible in the data.
Throwaway schema only (pg_conn); never production."""
import importlib.util
import os
from datetime import date, timedelta

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def _load():
    path = os.path.join(REPO, 'scripts', 'repair', 'repair_unadjusted_splits.py')
    spec = importlib.util.spec_from_file_location('repair_unadjusted_splits', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def dump(tmp_path):
    p = tmp_path / 'stock_ohlcv.dump'
    p.write_bytes(b'PGDMP\x01\x0e\x00' + b'\x00' * 64)
    return str(p)


D0 = date(2026, 9, 1)


def _days(n):
    return [D0 + timedelta(days=i) for i in range(n)]


def _seed(conn):
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open FLOAT8, high FLOAT8, "
                 "low FLOAT8, close FLOAT8, volume BIGINT, is_suspect BIGINT DEFAULT 0)")
    conn.execute("CREATE TABLE ohlcv_adjustment_factors (symbol TEXT, ex_date DATE, factor REAL, source TEXT)")
    conn.execute("CREATE TABLE stock_corporate_action_history (symbol TEXT, action_type TEXT, "
                 "record_date DATE, ratio_factor REAL)")
    d = _days(12)

    def bars(sym, closes, vols=None):
        for i, c in enumerate(closes):
            v = 1000 if vols is None else vols[i]
            conn.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
                         "VALUES (?,?,?,?,?,?,?)", (sym, d[i], c, c * 1.01, c * 0.99, c, v))

    # SPLT: 1:2 split on d[6]; every earlier bar is on the old basis.
    bars('SPLT', [100] * 6 + [50] * 6)
    conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('SPLT', ?, 0.5, 'mc')", (d[6],))
    # CRSH: a real -50% crash with no corporate action anywhere.
    bars('CRSH', [100] * 6 + [50] * 6)
    # MISM: -50% two days from a 1:5 factor -- the ratio does not match, leave it.
    bars('MISM', [100] * 6 + [50] * 6)
    conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('MISM', ?, 0.2, 'mc')", (d[6],))
    # SEAM (CHOICEIN 2024-02-19 shape): adjusted history, ONE raw old-basis bar, then the ex-date.
    bars('SEAM', [50] * 5 + [100] + [50] * 6)
    conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('SEAM', ?, 0.5, 'mc')", (d[6],))
    # PHAN (KRISHANA 2026-06-26 shape): a zero-volume bar already on the new basis before the seam.
    bars('PHAN', [100] * 4 + [50] + [100] + [50] * 6, vols=[1000] * 4 + [0] + [1000] * 7)
    conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('PHAN', ?, 0.5, 'mc')", (d[6],))
    conn.commit()
    return d


def _snap(conn):
    return {(r[0], date.fromisoformat(str(r[1])[:10])): (round(r[2], 6), r[3]) for r in conn.execute(
        "SELECT symbol, date, close, volume FROM stock_ohlcv").fetchall()}


def test_split_gap_backward_adjusted_exactly_once(pg_conn, dump):
    m, d = _load(), _seed(pg_conn)
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    s = _snap(pg_conn)
    assert [s[('SPLT', x)] for x in d] == [(50.0, 2000)] * 6 + [(50.0, 1000)] * 6
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    assert _snap(pg_conn) == s, 'second run must change nothing'


def test_crash_and_ratio_mismatch_untouched(pg_conn, dump):
    m, d = _load(), _seed(pg_conn)
    before = _snap(pg_conn)
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    after = _snap(pg_conn)
    for sym in ('CRSH', 'MISM'):
        assert [after[(sym, x)] for x in d] == [before[(sym, x)] for x in d]


def test_single_raw_bar_inside_adjusted_history(pg_conn, dump):
    m, d = _load(), _seed(pg_conn)
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    s = _snap(pg_conn)
    assert [s[('SEAM', x)][0] for x in d] == [50.0] * 12
    assert s[('SEAM', d[5])][1] == 2000 and s[('SEAM', d[4])][1] == 1000


def test_new_basis_phantom_bar_not_adjusted(pg_conn, dump):
    m, d = _load(), _seed(pg_conn)
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    s = _snap(pg_conn)
    assert [s[('PHAN', x)][0] for x in d] == [50.0] * 12


def test_dry_run_changes_nothing_and_reports_counts(pg_conn, capsys):
    m, _ = _load(), _seed(pg_conn)
    before = _snap(pg_conn)
    assert m.main([], conn=pg_conn) == 0
    out = capsys.readouterr().out
    assert 'stock_ohlcv[SPLT]: would update 6' in out
    assert 'stock_ohlcv[SEAM]: would update 1' in out
    assert 'ratio_mismatch' in out and 'CRSH' not in out
    assert _snap(pg_conn) == before


@pytest.mark.parametrize('extra', [[], ['--dump-path', 'Z:/no/such/file.dump']])
def test_apply_refuses_without_dump(pg_conn, extra):
    m, _ = _load(), _seed(pg_conn)
    before = _snap(pg_conn)
    assert m.main(['--apply'] + extra, conn=pg_conn) == 2
    assert _snap(pg_conn) == before


def test_moneycontrol_ratio_preferred_over_snapped_heuristic(pg_conn, dump):
    """KAPSTON 2026-03-06: the table holds the heuristic 0.7 (snapped off a day that also moved),
    MoneyControl holds the declared 1:2 bonus, 2/3. The seam is exactly 2/3 -- applying 0.7 would
    leave a -5% step in the history."""
    m, d = _load(), _seed(pg_conn)
    for i, c in enumerate([90.0] * 6 + [60.0] * 6):
        pg_conn.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
                        "VALUES ('BONS', ?, ?, ?, ?, ?, 300)", (d[i], c, c * 1.01, c * 0.99, c))
    pg_conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('BONS', ?, 0.7, 'bhavcopy_prev_close')", (d[6],))
    pg_conn.execute("INSERT INTO stock_corporate_action_history VALUES ('BONS', 'bonus', ?, 0.6666667)", (d[6],))
    pg_conn.commit()
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    s = _snap(pg_conn)
    assert [round(s[('BONS', x)][0], 3) for x in d] == [60.0] * 12


def test_undeclared_circuit_band_factor_not_applied(pg_conn, dump):
    """AKI 2025-07-07: ohlcv_adjust stored 1.2 for a +20% upper-circuit run. A price-only factor
    inside the circuit band with no declared action is indistinguishable from a circuit day."""
    m, d = _load(), _seed(pg_conn)
    closes = [10.0] * 6 + [12.0, 14.4, 17.28] + [17.28] * 3
    for i, c in enumerate(closes):
        lo = c if i < 6 else c * 0.999
        pg_conn.execute("INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume) "
                        "VALUES ('CIRC', ?, ?, ?, ?, ?, 500)", (d[i], c, c, lo, c))
    pg_conn.execute("INSERT INTO ohlcv_adjustment_factors VALUES ('CIRC', ?, 1.2, 'bhavcopy_prev_close')", (d[6],))
    pg_conn.commit()
    before = _snap(pg_conn)
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    after = _snap(pg_conn)
    assert [after[('CIRC', x)] for x in d] == [before[('CIRC', x)] for x in d]


def test_update_lands_on_compressed_hypertable_chunks(pg_conn, dump):
    """The production path: stock_ohlcv is a hypertable compressed by symbol. The keyed UPDATE must
    reach rows inside compressed chunks, in the one transaction, and a second run change nothing."""
    if not pg_conn.execute("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'").fetchall():
        pytest.skip('timescaledb not installed in the test database')
    m, d = _load(), _seed(pg_conn)
    pg_conn.execute("SELECT public.create_hypertable('stock_ohlcv', 'date', chunk_time_interval => INTERVAL '3 days', "
                    "migrate_data => true)")
    pg_conn.execute("ALTER TABLE stock_ohlcv SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol', "
                    "timescaledb.compress_orderby = 'date DESC')")
    n = len(pg_conn.execute("SELECT public.compress_chunk(c) FROM public.show_chunks('stock_ohlcv') c").fetchall())
    pg_conn.commit()
    assert n >= 3
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    s = _snap(pg_conn)
    assert [s[('SPLT', x)] for x in d] == [(50.0, 2000)] * 6 + [(50.0, 1000)] * 6
    assert m.main(['--apply', '--dump-path', dump], conn=pg_conn) == 0
    assert _snap(pg_conn) == s
