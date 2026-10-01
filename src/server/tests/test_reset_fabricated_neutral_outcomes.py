"""AF-20261001-30 backfill: only expiry-fabricated NEUTRAL 0.0% rows on priceable symbols go back
to PENDING; real time-exit NEUTRALs, SUSPECT_DATA rows and untradeable codes are left alone."""
import csv
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'scripts'))
from pg_test_support import pg_memory_conn  # noqa: E402
import reset_fabricated_neutral_outcomes as reset  # noqa: E402

SIG = '2026-08-03'


def _db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE stock_ohlcv (symbol TEXT, date DATE, close REAL, is_suspect INTEGER DEFAULT 0);
        CREATE TABLE unified_signal_outcomes (unified_signal_id INTEGER, symbol TEXT, signal_date TEXT,
            horizon_days INTEGER, outcome TEXT, return_pct REAL, exit_price REAL, computed_at TEXT);
        CREATE TABLE signal_outcomes (symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            signal_source TEXT, outcome TEXT, return_pct REAL, exit_price REAL, computed_at TEXT);
        CREATE TABLE recommendation_log (id INTEGER, symbol TEXT, signal_date TEXT, outcome TEXT,
            actual_return_pct REAL, actual_exit_price REAL, status TEXT, resolved_at TEXT,
            horizon_days INTEGER DEFAULT 15);
    """)
    conn.execute("INSERT INTO stock_ohlcv VALUES ('LIVE','2026-08-04',100,0)")
    rows = [  # symbol, outcome, ret, exit_px
        ('LIVE', 'NEUTRAL', 0.0, None),    # fabricated -> reset
        ('LIVE', 'NEUTRAL', 0.0, 100.0),   # real flat time exit -> keep
        ('LIVE', 'NEUTRAL', None, None),   # SUSPECT_DATA -> keep
        ('GONE', 'NEUTRAL', 0.0, None),    # no bar after signal -> keep
    ]
    for i, (sym, out, ret, px) in enumerate(rows):
        conn.execute("INSERT INTO unified_signal_outcomes VALUES (?,?,?,1,?,?,?,NULL)", (i, sym, SIG, out, ret, px))
        conn.execute("INSERT INTO signal_outcomes VALUES (?,?,?,'technical',?,?,?,NULL)", (sym, SIG, i + 2, out, ret, px))  # h1 kept for the stamped case
        conn.execute("INSERT INTO recommendation_log (id, symbol, signal_date, outcome, actual_return_pct, "
                     "actual_exit_price, status) VALUES (?,?,?,?,?,?,'RESOLVED')", (i, sym, SIG, out, ret, px))
    # a real h1 technical label, copied onto a 15-session recommendation by performance_tracker
    conn.execute("INSERT INTO signal_outcomes VALUES ('LIVE',?,1,'technical','WIN',1.5,101.0,NULL)", (SIG,))
    conn.execute("INSERT INTO recommendation_log (id, symbol, signal_date, outcome, actual_return_pct, "
                 "actual_exit_price, status) VALUES (9,'LIVE',?,'WIN',1.5,101.0,'RESOLVED')", (SIG,))
    conn.commit()
    return conn


def test_dry_run_counts_only_fabricated_rows_and_writes_nothing():
    conn = _db()
    assert reset.run(conn, apply=False, backup_dir=None) == {
        'unified_signal_outcomes': 1, 'signal_outcomes': 1, 'recommendation_log': 1,
        'recommendation_log_h1_stamped': 1}
    assert conn.execute("SELECT COUNT(*) FROM signal_outcomes WHERE outcome='PENDING'").fetchone()[0] == 0


def test_apply_backs_up_then_resets_only_fabricated_rows(tmp_path):
    conn = _db()
    reset.run(conn, apply=True, backup_dir=str(tmp_path))
    for t, idcol, want in (('unified_signal_outcomes', 'unified_signal_id', [0]),
                           ('signal_outcomes', 'horizon_days', [2]), ('recommendation_log', 'id', [0, 9])):
        pend = sorted(r[0] for r in conn.execute(f"SELECT {idcol} FROM {t} WHERE outcome='PENDING'").fetchall())
        assert pend == want, t
    for name in reset.TARGETS:
        with open(tmp_path / f"{name}.csv", encoding='utf-8') as f:
            assert len(list(csv.reader(f))) == 2, name   # header + the one row
    assert conn.execute("SELECT status FROM recommendation_log WHERE id=0").fetchone()[0] == 'ACTIVE'
