"""AF-20261112-12: scripts/repair/repair_single_bars.py fixes stock_ohlcv bars that are partial-day snapshots or
mixed-basis phantoms. The planners are pure; one test runs the real harness on a throwaway schema."""
import importlib.util
import os
import sys
from datetime import date

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))


def _load():
    sys.path.insert(0, os.path.join(REPO, 'scripts', 'repair'))
    path = os.path.join(REPO, 'scripts', 'repair', 'repair_single_bars.py')
    spec = importlib.util.spec_from_file_location('repair_single_bars', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# (open, high, low, close, volume): GOLDIAM 2026-06-15, a snapshot taken before the session ended
RAW = (480.0, 492.0, 464.75, 469.0, 1547840)
SNAP = (480.0, 492.0, 475.20, 483.20, 860800)


def test_bar_fix_replaces_a_partial_snapshot_with_the_official_range_close_and_volume():
    m = _load()
    assert m.bar_fix(SNAP, RAW) == (492.0, 464.75, 469.0, 1547840)
    assert m.bar_fix(RAW, RAW) is None                                              # nothing to fix


def test_bar_fix_refuses_anything_that_is_not_provably_a_raw_basis_snapshot():
    m = _load()
    adjusted = tuple(v * 0.75 for v in SNAP[:4]) + (SNAP[4],)
    assert m.bar_fix(adjusted, RAW) is None                                         # split-adjusted: open differs by the factor
    assert m.bar_fix((480.0, 520.0, 475.2, 483.2, 860800), RAW) is None             # production range wider than official
    assert m.bar_fix((480.0, 492.0, 440.0, 483.2, 860800), RAW) is None
    assert m.bar_fix((470.0, 485.0, 470.0, 483.2, 860800), RAW) is None             # inside the range but another open: not the same session
    assert m.bar_fix(SNAP, (480.0, 492.0, 464.75, None, 5)) is None                 # official row incomplete
    assert m.bar_fix(SNAP, None) is None and m.bar_fix(None, RAW) is None


def test_material_ignores_rounding_but_catches_a_wrong_close_range_or_half_volume():
    m = _load()
    assert m.material((480.0, 492.0, 464.75, 469.0, 1547840), RAW) is False
    assert m.material((480.0, 492.0, 464.75, 469.0, 1546000), RAW) is False         # 0.1% volume rounding (Yahoo vs NSE)
    assert m.material((480.0, 492.0, 464.75, 470.0, 1547840), RAW) is False         # close 0.2% off: below the floor
    assert m.material((480.0, 492.0, 464.75, 474.0, 1547840), RAW) is True          # close 1.1% off
    assert m.material((480.0, 492.0, 475.2, 469.0, 1547840), RAW) is True           # low 2.2% off
    assert m.material((480.0, 492.0, 464.75, 469.0, 860800), RAW) is True           # volume 44% off


def test_rebase_phantom_needs_a_quarantined_mixed_basis_bar():
    m = _load()
    reason = 'absent_from_official_bhavcopy'
    mixed = (14.91, 14.91, 14.91, 138.5, 42600000, 1, reason)                       # CCAVENUE 2026-10-13
    assert m.rebase_phantom(mixed, 10.0) is True
    assert m.rebase_phantom((149.1, 149.1, 149.1, 138.5, 4260000, 1, reason), 10.0) is False   # already rebased
    assert m.rebase_phantom((14.91, 14.91, 14.91, 138.5, 42600000, 0, reason), 10.0) is False  # not quarantined
    assert m.rebase_phantom((14.91, 14.91, 14.91, 138.5, 42600000, 1, 'other'), 10.0) is False
    assert m.rebase_phantom((14.91, 14.91, 14.91, 20.0, 42600000, 1, reason), 10.0) is False   # close not at the new basis


@pytest.fixture
def dump(tmp_path):
    p = tmp_path / 'stock_ohlcv.dump'
    p.write_bytes(b'PGDMP\x01\x0e\x00' + b'\x00' * 64)
    return str(p)


def _seed(conn):
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, open FLOAT8, high FLOAT8, low FLOAT8, "
                 "close FLOAT8, volume BIGINT, is_suspect BIGINT DEFAULT 0, suspect_reason TEXT)")
    conn.execute("CREATE TABLE nse_universe_history (symbol TEXT, date DATE, series TEXT, open FLOAT8, "
                 "high FLOAT8, low FLOAT8, close FLOAT8, volume BIGINT)")

    def bar(sym, d, prod, raw=RAW, sus=0):
        conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?,?,?,NULL)", (sym, d, *prod, sus))
        conn.execute("INSERT INTO nse_universe_history VALUES (?,?,'EQ',?,?,?,?,?)", (sym, d, *raw))

    d1, d2, d3 = date(2026, 6, 15), date(2026, 6, 16), date(2026, 6, 17)
    bar('GOLD', d1, SNAP)                                                            # named bar, partial snapshot
    bar('SWEEP', d2, SNAP)                                                           # found by the sweep
    bar('ROUND', d2, (480.0, 492.0, 464.75, 469.0, 1546000))                         # immaterial: sweep leaves it
    bar('ADJ', d2, tuple(v * 0.75 for v in SNAP[:4]) + (SNAP[4],))                   # adjusted basis: refused
    bar('QUAR', d2, SNAP, sus=1)                                                     # quarantined: sweep skips it
    bar('LATER', d3, SNAP)                                                           # outside the sweep range
    for day in (13, 14):
        conn.execute("INSERT INTO stock_ohlcv VALUES ('CCA',?,?,?,?,?,?,1,'absent_from_official_bhavcopy')",
                     (date(2026, 10, day), 14.91, 14.91, 14.91, 138.5, 42600000))
    conn.execute("INSERT INTO stock_ohlcv VALUES ('CCA',?,?,?,?,?,?,0,NULL)", (date(2026, 10, 16), 138.3, 138.3, 138.3, 138.3, 0))
    conn.commit()
    return d1, d2, d3


def test_apply_end_to_end_is_exact_guarded_and_idempotent(pg_conn, dump):
    m = _load()
    d1, d2, d3 = _seed(pg_conn)
    args = ['--bhavcopy-bar', 'GOLD:2026-06-15', '--sweep-bhavcopy', '2026-06-16:2026-06-16',
            '--rebase-phantom', 'CCA:2026-10-13:2026-10-16:10', '--apply', '--dump-path', dump]
    assert m.main(args, conn=pg_conn) == 0
    row = lambda s, d: tuple(round(v, 4) for v in pg_conn.execute(
        "SELECT open, high, low, close, volume FROM stock_ohlcv WHERE symbol=? AND date=?", (s, d)).fetchone())
    assert row('GOLD', d1) == RAW and row('SWEEP', d2) == RAW
    assert row('ROUND', d2)[4] == 1546000                                            # immaterial rounding left alone
    assert row('ADJ', d2)[0] == round(480.0 * 0.75, 4)                               # refused
    assert row('QUAR', d2) == tuple(round(v, 4) for v in SNAP)                       # quarantined, skipped
    assert row('LATER', d3) == tuple(round(v, 4) for v in SNAP)                      # outside the range
    for day in (13, 14):
        assert row('CCA', date(2026, 10, day)) == (149.1, 149.1, 149.1, 138.5, 4260000)
    assert row('CCA', date(2026, 10, 16)) == (138.3, 138.3, 138.3, 138.3, 0)         # not quarantined: untouched
    before = pg_conn.execute("SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv ORDER BY 1, 2").fetchall()
    assert m.main(args, conn=pg_conn) == 0
    assert pg_conn.execute("SELECT symbol, date, open, high, low, close, volume FROM stock_ohlcv ORDER BY 1, 2").fetchall() == before
