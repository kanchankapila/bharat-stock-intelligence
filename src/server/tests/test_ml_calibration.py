import sys, os, sqlite3
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from ml_calibration import (  # noqa: E402
    fit_calibrator,
    calibrate,
    recalibrate_win_probabilities,
    count_episodes,
    per_regime_auc,
    regime_readiness,
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
            nifty_regime TEXT,
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


# ── per-regime calibration: floor gating ────────────────────────────────────────

def _seed(conn, regime, p, win_count, dates):
    """For each date insert 10 symbols at prob p; win_count of every 10 are WIN."""
    i = 0
    for d in dates:
        for k in range(10):
            sym = f"{regime}_{d}_{k}"
            outcome = 'WIN' if (i % 10) < win_count else 'LOSS'
            conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                         (sym, d, p, regime))
            conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                         (sym, d, outcome))
            i += 1
    conn.commit()


def _spread_days(n, start="2026-01-01", gap_every=10):
    """n distinct days across 2 episodes (a 40-day jump at the midpoint)."""
    import datetime as dt
    base = dt.date.fromisoformat(start)
    out = []
    for i in range(n):
        off = i + (40 if i >= n // 2 else 0)
        out.append((base + dt.timedelta(days=off)).isoformat())
    return out


def test_qualified_regime_gets_own_calibrator():
    conn = make_db()
    # BEAR: 22 days across 2 episodes, raw 0.8 only wins 40% -> own calibrator pulls 0.8 down hard
    _seed(conn, 'BEAR', 0.8, 4, _spread_days(22))
    # BULL elsewhere with the SAME raw prob winning 80% -> would calibrate 0.8 differently
    _seed(conn, 'BULL', 0.8, 8, _spread_days(22, start="2025-06-01"))
    res = recalibrate_win_probabilities(conn, min_samples=50, min_regime_days=20, min_regime_episodes=2)
    assert res['regimes']['BEAR']['used'] == 'regime'
    bear = conn.execute("SELECT calibrated_win_probability FROM technical_signals WHERE nifty_regime='BEAR' LIMIT 1").fetchone()[0]
    bull = conn.execute("SELECT calibrated_win_probability FROM technical_signals WHERE nifty_regime='BULL' LIMIT 1").fetchone()[0]
    assert bear == pytest.approx(0.4, abs=0.08) and bull == pytest.approx(0.8, abs=0.08)
    assert bear < bull   # same raw 0.8 calibrates lower in BEAR


def test_below_days_floor_uses_global():
    conn = make_db()
    # only 6 distinct days (lots of rows) -> below the 20-day floor -> global
    _seed(conn, 'SIDEWAYS', 0.8, 6, ["2026-03-%02d" % d for d in range(1, 7)])
    _seed(conn, 'BULL', 0.2, 2, ["2026-04-%02d" % d for d in range(1, 7)])
    res = recalibrate_win_probabilities(conn, min_samples=50, min_regime_days=20, min_regime_episodes=2)
    assert res['regimes']['SIDEWAYS']['used'] == 'global'


def test_single_episode_uses_global():
    conn = make_db()
    # 25 distinct days but all contiguous (1 episode) -> fails episode floor -> global
    import datetime as dt
    days = [(dt.date(2026, 2, 1) + dt.timedelta(days=i)).isoformat() for i in range(25)]
    _seed(conn, 'BEAR', 0.8, 4, days)
    _seed(conn, 'BULL', 0.2, 2, [(dt.date(2025, 2, 1) + dt.timedelta(days=i)).isoformat() for i in range(25)])
    res = recalibrate_win_probabilities(conn, min_samples=50, min_regime_days=20, min_regime_episodes=2)
    assert res['regimes']['BEAR']['used'] == 'global'


# ── per-regime diagnostics ──────────────────────────────────────────────────────

def test_per_regime_auc_distinguishes_rankable_vs_random():
    conn = make_db()
    # RANKABLE: high prob -> win, low prob -> loss
    for i in range(100):
        p = 0.9 if i % 2 == 0 else 0.1
        y = 'WIN' if i % 2 == 0 else 'LOSS'
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"R{i}", f"2026-01-{i % 28 + 1:02d}", p, 'BULL'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                     (f"R{i}", f"2026-01-{i % 28 + 1:02d}", y))
    # RANDOM: prob unrelated to outcome
    for i in range(100):
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"X{i}", f"2026-02-{i % 28 + 1:02d}", 0.5, 'BEAR'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                     (f"X{i}", f"2026-02-{i % 28 + 1:02d}", 'WIN' if i < 50 else 'LOSS'))
    conn.commit()
    auc = per_regime_auc(conn, min_n=50)
    assert auc['BULL']['auc'] > 0.9
    assert 0.4 <= auc['BEAR']['auc'] <= 0.6


def test_regime_readiness_flags():
    conn = make_db()
    import datetime as dt
    ready_days = _spread_days(22)            # 22 days, 2 episodes -> ready
    not_days = [(dt.date(2026, 3, 1) + dt.timedelta(days=i)).isoformat() for i in range(5)]  # 5 days -> not
    for d in ready_days:
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"a{d}", d, 0.5, 'BEAR'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,'WIN')", (f"a{d}", d))
    for d in not_days:
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"b{d}", d, 0.5, 'BULL'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,'WIN')", (f"b{d}", d))
    conn.commit()
    rr = regime_readiness(conn)
    assert rr['BEAR']['ready'] is True and rr['BULL']['ready'] is False
