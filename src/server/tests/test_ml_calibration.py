import sys, os, sqlite3
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from ml_calibration import (  # noqa: E402
    fit_calibrator,
    calibrate,
    recalibrate_win_probabilities,
    count_episodes,
)


# ── isotonic fit + apply ────────────────────────────────────────────────────────

def _overconfident_dataset():
    # model says 0.2 (wins 20%) and 0.8 (wins 60%) — overconfident at the top end
    data = [(0.2, 0)] * 80 + [(0.2, 1)] * 20 + [(0.8, 1)] * 60 + [(0.8, 0)] * 40
    return [d[0] for d in data], [d[1] for d in data]


def test_calibrator_maps_to_empirical_rates():
    preds, ys = _overconfident_dataset()
    ir = fit_calibrator(preds, ys)
    assert calibrate(ir, 0.2) == pytest.approx(0.2, abs=0.05)
    assert calibrate(ir, 0.8) == pytest.approx(0.6, abs=0.05)


def test_calibrator_compresses_overconfidence():
    preds, ys = _overconfident_dataset()
    ir = fit_calibrator(preds, ys)
    assert calibrate(ir, 0.8) < 0.8   # 0.8 prediction that really wins 60% gets pulled down


def test_calibrator_is_monotonic():
    preds, ys = _overconfident_dataset()
    ir = fit_calibrator(preds, ys)
    assert calibrate(ir, 0.2) <= calibrate(ir, 0.5) <= calibrate(ir, 0.8)


def test_calibrator_clips_out_of_range():
    preds, ys = _overconfident_dataset()
    ir = fit_calibrator(preds, ys)
    assert 0.0 <= calibrate(ir, 0.99) <= 1.0
    assert 0.0 <= calibrate(ir, 0.01) <= 1.0


# ── DB job: write calibrated_win_probability ────────────────────────────────────

def make_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, win_probability REAL, calibrated_win_probability REAL,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER, outcome TEXT,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
    """)
    return conn


def test_recalibrate_writes_compressed_probabilities():
    conn = make_db()
    # 100 signals at p=0.2 (20% win) and 100 at p=0.8 (60% win), each with a paired outcome
    n = 0
    for p, wins in [(0.2, 20), (0.8, 60)]:
        for i in range(100):
            sym, day = f"S{p}_{i}", f"2026-01-{(i % 28) + 1:02d}"
            outcome = 'WIN' if i < wins else 'LOSS'
            conn.execute("INSERT INTO technical_signals (symbol,date,win_probability) VALUES (?,?,?)", (sym, day, p))
            conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)", (sym, day, outcome))
            n += 1
    conn.commit()

    res = recalibrate_win_probabilities(conn, min_samples=50)
    assert res['fit'] is True
    # the 0.8 cohort must be recalibrated down toward its true ~0.6
    cal_hi = conn.execute("SELECT calibrated_win_probability FROM technical_signals WHERE win_probability=0.8 LIMIT 1").fetchone()[0]
    assert cal_hi == pytest.approx(0.6, abs=0.06)
    assert cal_hi < 0.8


def test_recalibrate_skips_when_insufficient_data():
    conn = make_db()
    conn.execute("INSERT INTO technical_signals (symbol,date,win_probability) VALUES ('A','2026-01-01',0.7)")
    conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES ('A','2026-01-01',5,'WIN')")
    conn.commit()
    res = recalibrate_win_probabilities(conn, min_samples=50)
    assert res['fit'] is False


# ── per-regime calibration: episode counting ────────────────────────────────────

def test_count_episodes():
    assert count_episodes([]) == 0
    assert count_episodes(["2024-01-01", "2024-01-02", "2024-01-03"]) == 1
    assert count_episodes(["2024-01-01", "2024-01-02", "2024-02-01", "2024-02-02"]) == 2  # gap > 5
    assert count_episodes(["2024-01-03", "2024-01-01", "2024-01-02"]) == 1                # unsorted ok
