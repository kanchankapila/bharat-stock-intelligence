"""AF-20261001-45: ml_calibration refit nightly on every resolved outcome and then rewrote
calibrated_win_probability for EVERY historical row -- each row's value came from a calibrator
that had seen that row's own outcome. backtester.py reads the column historically.
Also: STOP_LOSS outcomes (a loss) were dropped from the fit, inflating the WIN rate.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
from ml_calibration import recalibrate_win_probabilities  # noqa: E402


def _db():
    c = pg_memory_conn()
    c.row_factory = sqlite3.Row
    c.executescript("""
        CREATE TABLE technical_signals (symbol TEXT, date DATE, win_probability DOUBLE PRECISION,
            calibrated_win_probability DOUBLE PRECISION, nifty_regime TEXT, PRIMARY KEY (symbol, date));
        CREATE TABLE signal_outcomes (symbol TEXT, signal_date DATE, horizon_days INTEGER, outcome TEXT,
            signal_source TEXT NOT NULL DEFAULT 'technical');
    """)
    for p, wins in [(0.2, 20), (0.8, 60)]:
        for i in range(100):
            sym, day = f"S{p}_{i}", f"2026-01-{(i % 28) + 1:02d}"
            c.execute("INSERT INTO technical_signals VALUES (?,?,?,0.111,NULL)", (sym, day, p))
            c.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                      (sym, day, 'WIN' if i < wins else ('STOP_LOSS' if i % 2 else 'LOSS')))
    c.execute("INSERT INTO technical_signals VALUES ('NEW','2026-02-02',0.8,NULL,NULL)")
    c.commit()
    return c


def test_rows_inside_the_fit_window_are_not_rewritten():
    c = _db()
    recalibrate_win_probabilities(c, min_samples=50)
    old = {r[0] for r in c.execute(
        "SELECT DISTINCT calibrated_win_probability FROM technical_signals WHERE symbol <> 'NEW'")}
    assert old == {0.111}
    new = c.execute("SELECT calibrated_win_probability FROM technical_signals WHERE symbol='NEW'").fetchone()[0]
    assert new is not None and abs(new - 0.6) < 0.06


def test_stop_loss_is_a_loss_in_the_fit():
    res = recalibrate_win_probabilities(_db(), min_samples=50)
    assert res['n'] == 200
