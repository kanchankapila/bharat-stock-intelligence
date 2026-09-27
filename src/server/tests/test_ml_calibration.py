import sys, os, sqlite3
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

from ml_calibration import (  # noqa: E402
    fit_calibrator,
    calibrate,
    recalibrate_win_probabilities,
    count_episodes,
    per_regime_auc,
    regime_readiness,
    ensure_edge_status_table,
    persist_regime_edge_status,
    load_regime_edge_status,
    collapse_regime5,
    regime_edge_weight,
    edge_adjusted_probability,
    is_edge_adjustment_enabled,
    stratified_auc,
    stratified_calibration_slope,
    AUC_RANDOM,
    AUC_TRUST_FLOOR,
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
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, win_probability REAL, calibrated_win_probability REAL,
            nifty_regime TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER, outcome TEXT,
            -- ml_calibration.py only trains on signal_source='technical' rows (2026-08 fix);
            -- every INSERT in this file grades a technical_signals-shaped scenario, so default
            -- to 'technical' rather than touching every INSERT statement individually.
            signal_source TEXT NOT NULL DEFAULT 'technical',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
        );
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
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


def test_recalibrate_rewrites_only_rows_whose_value_changes():
    # The job re-fits nightly and used to rewrite EVERY scored row in history: measured
    # 2026-09-11, 115,284 rewrites of which only 36,485 (31.6%) changed value. An UPDATE to an
    # identical value still writes a new tuple, which xmin exposes.
    conn = make_db()
    # Production's column is double precision; float4 REAL would never compare equal.
    conn.execute("ALTER TABLE technical_signals ALTER COLUMN calibrated_win_probability TYPE DOUBLE PRECISION")
    conn.execute("ALTER TABLE technical_signals ALTER COLUMN win_probability TYPE DOUBLE PRECISION")
    for p, wins in [(0.2, 20), (0.8, 60)]:
        for i in range(100):
            sym, day = f"S{p}_{i}", f"2026-01-{(i % 28) + 1:02d}"
            conn.execute("INSERT INTO technical_signals (symbol,date,win_probability) VALUES (?,?,?)", (sym, day, p))
            conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                         (sym, day, 'WIN' if i < wins else 'LOSS'))
    # Scored but not yet resolved: calibrated by the fit without being part of it.
    conn.execute("INSERT INTO technical_signals (symbol,date,win_probability) VALUES ('NEW','2026-02-02',0.2)")
    conn.commit()
    recalibrate_win_probabilities(conn, min_samples=50)

    def versions():
        return {(r[0], r[1]): r[2] for r in conn.execute(
            "SELECT symbol, date::text, xmin::text FROM technical_signals").fetchall()}

    before = versions()
    recalibrate_win_probabilities(conn, min_samples=50)
    assert versions() == before  # same data, same fit: nothing rewritten

    conn.execute("UPDATE technical_signals SET win_probability = 0.8 WHERE symbol = 'NEW'")
    conn.commit()
    before = versions()
    res = recalibrate_win_probabilities(conn, min_samples=50)
    after = versions()
    assert {k for k in before if before[k] != after[k]} == {('NEW', '2026-02-02')}
    assert res['updated'] == 201


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
    # RANDOM: prob unrelated to outcome. Alternates 0.3/0.7 by i%2, independent of the i<50
    # WIN/LOSS split -- NOT a constant 0.5, which per_regime_auc/regime_readiness treat as the
    # "unscored" sentinel and exclude outright (this used to be a literal 0.5 here, which made
    # every BEAR row invisible to the query and raised KeyError on auc['BEAR'] below).
    for i in range(100):
        p = 0.3 if i % 2 == 0 else 0.7
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"X{i}", f"2026-02-{i % 28 + 1:02d}", p, 'BEAR'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,?)",
                     (f"X{i}", f"2026-02-{i % 28 + 1:02d}", 'WIN' if i < 50 else 'LOSS'))
    conn.commit()
    auc = per_regime_auc(conn, min_n=50)
    assert auc['BULL']['auc'] > 0.9
    assert 0.4 <= auc['BEAR']['auc'] <= 0.6


def test_per_regime_auc_ignores_confluence_sourced_outcome_rows():
    """The actual 2026-08 bug: signal_outcomes has no source discriminator, so a
    confluence-sourced outcome row sharing (symbol, date) with an unrelated technical_signals
    row used to get joined in and treated as if it graded that signal's win_probability. A
    confluence-sourced row with the OPPOSITE outcome of the real technical-sourced row must not
    change the computed AUC."""
    conn = make_db()
    for i in range(60):
        p = 0.2 if i < 30 else 0.8
        y = 'LOSS' if i < 30 else 'WIN'  # low p -> LOSS, high p -> WIN: cleanly rankable
        day = f"2026-04-{i % 28 + 1:02d}"
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"S{i}", day, p, 'SIDEWAYS'))
        conn.execute(
            "INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome,signal_source) "
            "VALUES (?,?,5,?,'technical')", (f"S{i}", day, y))
        # A confluence-sourced row for the SAME (symbol, date) with the opposite outcome --
        # must be excluded, not blended into the technical-sourced AUC computation.
        conn.execute(
            "INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome,signal_source) "
            "VALUES (?,?,5,?,'confluence')", (f"S{i}", day, 'LOSS' if y == 'WIN' else 'WIN'))
    conn.commit()
    auc = per_regime_auc(conn, min_n=50)
    # If the confluence rows leaked in, the join would return 2 rows per signal with
    # contradictory outcomes and AUC would collapse toward 0.5, not the clean signal here.
    assert auc['SIDEWAYS']['auc'] > 0.9


# ── horizon stratification (2026-09-24 Simpson's-paradox fix) ───────────────────

# (horizon, win_rate, p_low, p_high) -- the live HIGH_VOL shape: the SHORT horizon's signals carry
# the HIGHEST scores and the LONGEST the lowest, while win rate rises with horizon. Within each
# horizon the top `win_rate` fraction by p are the WINS, so p is perfectly rankable per stratum.
# Pooled, "higher confidence" therefore means "shorter horizon" and "more likely to lose".
_HORIZON_SKEW = ((1, 0.20, 0.80, 0.95),     # high p, low  win rate
                 (5, 0.65, 0.45, 0.65),     # mid  p, mid  win rate
                 (15, 0.90, 0.05, 0.25))    # low  p, high win rate
_HORIZON_SKEW_N = 600


def _horizon_skewed_pairs():
    """A population where every horizon is PERFECTLY rankable, yet pooling them reports a
    sub-0.5 AUC -- the live 2026-09-24 shape that pinned HIGH_VOL's edge weight at 0.
    See _HORIZON_SKEW for the construction.

    The construction mirrors the real one: the SHORT horizon's signals carry the HIGHEST scores
    and the LONGEST carry the lowest, while win rate rises with horizon. Within each horizon p
    is perfectly rankable (the top `win_rate` fraction by p are the WINS -> per-stratum AUC 1.0).
    Pooled, "higher confidence" therefore means "shorter horizon" and "more likely to lose", so
    the pooled ranking measures the horizon rather than the model.
    """
    pairs = []
    for h, win_rate, p_lo, p_hi in _HORIZON_SKEW:
        n = _HORIZON_SKEW_N
        wins = int(round(n * win_rate))
        for i in range(n):
            p = p_lo + (p_hi - p_lo) * i / (n - 1)   # strictly ascending
            y = 1 if i >= n - wins else 0             # top `wins` scores win
            pairs.append((h, p, y))
    return pairs


def test_stratified_auc_cannot_fall_below_all_its_own_strata():
    """The invariant the pooled metric violated: HIGH_VOL's pooled AUC read 0.467 while its
    strata read 0.648/0.550/0.552. A weighted mean cannot lie outside the range of its parts, so
    this assertion is the structural guarantee -- if it ever fails, the aggregation is wrong."""
    from sklearn.metrics import roc_auc_score
    pairs = _horizon_skewed_pairs()
    res = stratified_auc(pairs, min_n=50)
    assert res is not None
    lo = min(v['auc'] for v in res['strata'].values())
    hi = max(v['auc'] for v in res['strata'].values())
    assert lo <= res['auc'] <= hi, f"stratified AUC {res['auc']} outside [{lo}, {hi}]"


def test_stratified_auc_recovers_rankability_pooling_destroyed():
    """The regression itself. Every stratum is perfectly rankable, so the honest estimate is 1.0;
    pooling these horizons reports a sub-0.5 AUC that no stratum supports."""
    from sklearn.metrics import roc_auc_score
    pairs = _horizon_skewed_pairs()
    pooled = float(roc_auc_score([y for _, _, y in pairs], [p for _, p, _ in pairs]))
    res = stratified_auc(pairs, min_n=50)
    assert res['auc'] > 0.95, f"stratified AUC should recover the real edge, got {res['auc']}"
    # The artifact being fixed: pooling is not merely worse, it is *anti*-correlated with skill.
    assert pooled < 0.55, f"fixture no longer reproduces the artifact (pooled={pooled})"
    assert res['auc'] > pooled


def test_per_regime_auc_does_not_pool_horizons():
    """End-to-end through the SQL join: a regime whose horizons disagree on base rate but agree
    on ranking must not be reported below the trust floor."""
    conn = make_db()
    for h, win_rate, p_lo, p_hi in _HORIZON_SKEW:
        n = _HORIZON_SKEW_N
        wins = int(round(n * win_rate))
        for i in range(n):
            p = p_lo + (p_hi - p_lo) * i / (n - 1)   # strictly ascending within the horizon
            y = 'WIN' if i >= n - wins else 'LOSS'    # top `wins` scores win -> rankable
            day = f"2026-05-{(i % 28) + 1:02d}"
            conn.execute(
                "INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                (f"H{h}_{i}", day, p, 'HIGH_VOL'))
            conn.execute(
                "INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,?,?)",
                (f"H{h}_{i}", day, h, y))
    conn.commit()
    auc = per_regime_auc(conn, min_n=50)
    assert auc['HIGH_VOL']['auc'] > AUC_TRUST_FLOOR, (
        f"HIGH_VOL scored {auc['HIGH_VOL']['auc']:.3f} -- at/below the trust floor despite "
        "being perfectly rankable within every horizon")
    # All three horizons must be represented as separate strata.
    assert set(auc['HIGH_VOL']['strata']) == {1, 5, 15}


def test_stratified_auc_drops_single_class_and_tiny_strata():
    """A stratum that holds one class (or is too small to support an estimate) must be dropped,
    not scored -- roc_auc_score would raise, and a 25-row AUC would swing the weighted mean."""
    pairs = ([(1, 0.1 + 0.001 * i, i % 2) for i in range(600)]      # healthy
             + [(2, 0.5, 1) for i in range(50)]                        # single class
             + [(3, 0.5, i % 2) for i in range(25)])                   # too small
    res = stratified_auc(pairs, min_n=50)
    assert set(res['strata']) == {1}
    assert set(res['dropped_strata']) == {2, 3}


def test_stratified_auc_returns_none_when_nothing_survives():
    assert stratified_auc([(1, 0.5, 1) for _ in range(300)], min_n=50) is None
    assert stratified_auc([(1, 0.5, 1) for _ in range(10)], min_n=50) is None


def test_stratified_auc_ignores_non_finite_scores():
    """A stored NaN/inf passes `IS NOT NULL` but roc_auc_score rejects it; isfinite() is the
    guard (an inf is a real, non-NULL float that would poison the whole stratum)."""
    pairs = ([(1, 0.1 + 0.001 * i, i % 2) for i in range(600)]
             + [(1, float('nan'), 1), (1, float('inf'), 0)])
    res = stratified_auc(pairs, min_n=50)
    assert res is not None and res['n'] == 600


def test_regime_readiness_flags():
    conn = make_db()
    import datetime as dt
    ready_days = _spread_days(22)            # 22 days, 2 episodes -> ready
    not_days = [(dt.date(2026, 3, 1) + dt.timedelta(days=i)).isoformat() for i in range(5)]  # 5 days -> not
    # win_probability=0.5 exactly is the "unscored" sentinel that regime_readiness's query
    # excludes (AND ts.win_probability <> 0.5) -- use 0.6 so these rows are actually visible
    # to it (was 0.5, which made every row here invisible and raised KeyError on rr['BEAR']).
    for d in ready_days:
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"a{d}", d, 0.6, 'BEAR'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,'WIN')", (f"a{d}", d))
    for d in not_days:
        conn.execute("INSERT INTO technical_signals (symbol,date,win_probability,nifty_regime) VALUES (?,?,?,?)",
                     (f"b{d}", d, 0.6, 'BULL'))
        conn.execute("INSERT INTO signal_outcomes (symbol,signal_date,horizon_days,outcome) VALUES (?,?,5,'WIN')", (f"b{d}", d))
    conn.commit()
    rr = regime_readiness(conn)
    assert rr['BEAR']['ready'] is True and rr['BULL']['ready'] is False


# ── regime_edge_status persistence ──────────────────────────────────────────────

def test_persist_regime_edge_status_writes_and_upserts():
    conn = make_db()
    _seed(conn, 'BEAR', 0.8, 4, _spread_days(22))
    _seed(conn, 'BULL', 0.8, 8, _spread_days(22, start="2025-06-01"))
    out1 = persist_regime_edge_status(conn, min_n=50, min_regime_days=20, min_regime_episodes=2)
    assert 'BEAR' in out1 and 'BULL' in out1 and '__GLOBAL__' in out1
    rows1 = conn.execute("SELECT regime FROM regime_edge_status").fetchall()
    assert len(rows1) == len(set(r[0] for r in rows1))  # no duplicate regime keys

    # second run with different data must UPSERT (overwrite), not duplicate
    _seed(conn, 'BEAR', 0.9, 1, _spread_days(22, start="2024-01-01"))
    out2 = persist_regime_edge_status(conn, min_n=50, min_regime_days=20, min_regime_episodes=2)
    rows2 = conn.execute("SELECT regime FROM regime_edge_status").fetchall()
    assert len(rows2) == len(set(r[0] for r in rows2))
    assert len(rows2) == len(rows1)  # same regimes, no new rows appended


def test_load_regime_edge_status_roundtrip():
    conn = make_db()
    _seed(conn, 'BEAR', 0.8, 4, _spread_days(22))
    persist_regime_edge_status(conn, min_n=50, min_regime_days=20, min_regime_episodes=2)
    loaded = load_regime_edge_status(conn)
    assert 'BEAR' in loaded
    assert loaded['BEAR']['ready'] is True
    assert isinstance(loaded['BEAR']['auc'], float)


def test_load_regime_edge_status_empty_table_returns_empty_dict():
    conn = make_db()
    ensure_edge_status_table(conn)
    assert load_regime_edge_status(conn) == {}


def test_load_regime_edge_status_missing_table_returns_empty_dict():
    conn = make_db()
    assert load_regime_edge_status(conn) == {}


# ── is_edge_adjustment_enabled ────────────────────────────────────────────────────

def test_edge_adjustment_defaults_off_when_unset():
    conn = make_db()
    assert is_edge_adjustment_enabled(conn) is False


def test_edge_adjustment_off_when_explicitly_false():
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'false')")
    conn.commit()
    assert is_edge_adjustment_enabled(conn) is False


def test_edge_adjustment_on_when_explicitly_true():
    conn = make_db()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")
    conn.commit()
    assert is_edge_adjustment_enabled(conn) is True


# ── collapse_regime5 ─────────────────────────────────────────────────────────────

def test_collapse_regime5():
    assert collapse_regime5('BULL') == 'BULL'
    assert collapse_regime5('SIDEWAYS') == 'SIDEWAYS'
    assert collapse_regime5('HIGH_VOL') == 'BEAR'
    assert collapse_regime5('BEAR') == 'BEAR'
    assert collapse_regime5('CRASH') == 'BEAR'
    assert collapse_regime5(None) is None
    assert collapse_regime5('') is None


# ── regime_edge_weight ───────────────────────────────────────────────────────────

def _edge_status(**regimes):
    """Build a minimal edge_status dict for pure-function tests, e.g.
    _edge_status(BEAR={'auc': 0.61, 'ready': True}, __GLOBAL__={'auc': 0.50})."""
    return dict(regimes)


def test_regime_edge_weight_full_trust_at_or_above_floor():
    es = _edge_status(BEAR={'auc': 0.61, 'ready': True})
    assert regime_edge_weight('BEAR', es) == pytest.approx(1.0)
    es2 = _edge_status(BEAR={'auc': AUC_TRUST_FLOOR, 'ready': True})
    assert regime_edge_weight('BEAR', es2) == pytest.approx(1.0)


def test_regime_edge_weight_full_shrink_at_random():
    es = _edge_status(BULL={'auc': AUC_RANDOM, 'ready': True})
    assert regime_edge_weight('BULL', es) == pytest.approx(0.0)


def test_regime_edge_weight_below_random_clamps_to_zero():
    es = _edge_status(BULL={'auc': 0.42, 'ready': True})
    assert regime_edge_weight('BULL', es) == pytest.approx(0.0)


def test_regime_edge_weight_linear_between():
    mid_auc = (AUC_RANDOM + AUC_TRUST_FLOOR) / 2
    es = _edge_status(SIDEWAYS={'auc': mid_auc, 'ready': True})
    assert regime_edge_weight('SIDEWAYS', es) == pytest.approx(0.5, abs=1e-6)


# ── calib_slope drives the weight (AF-20260927-08) ───────────────────────────────
# The four tests above all pass AUC-only rows, so they now double as the fallback path's
# regression coverage -- a snapshot written before calib_slope existed must keep the old
# behaviour rather than silently jumping to full trust.

def test_slope_drives_the_weight_and_auc_is_ignored_when_both_present():
    # AUC says "full trust" (0.61 is comfortably over the 0.55 floor); the measured slope says the
    # probability is over-confident and should be halved. The slope must win -- AUC measures
    # ordering and cannot see scale, which is the entire reason for this change.
    es = _edge_status(BEAR={'auc': 0.61, 'calib_slope': 0.47, 'ready': True})
    assert regime_edge_weight('BEAR', es) == pytest.approx(0.47)


def test_slope_clamps_to_unit_interval():
    # A negative slope means the probability's SCALE is inverted. Clamp to 0 -> p collapses to 0.5,
    # which every consumer already reads as "no opinion" (bet_size_from_probability(<=0.5) == 0).
    # Letting it through negative would actively invert the signal.
    assert regime_edge_weight('X', _edge_status(X={'calib_slope': -0.244, 'ready': True})) == 0.0
    assert regime_edge_weight('X', _edge_status(X={'calib_slope': 1.8, 'ready': True})) == 1.0


def test_slope_falls_back_to_auc_when_absent():
    # Load-bearing: until ml_calibration.py next runs, every persisted row has calib_slope NULL.
    es = _edge_status(BEAR={'auc': 0.525, 'calib_slope': None, 'ready': True})
    assert regime_edge_weight('BEAR', es) == pytest.approx(0.5, abs=1e-6)


def test_slope_respects_the_same_ready_and_global_fallback_order():
    # An un-ready regime must not use its own slope; it collapses to the 3-class key, then
    # __GLOBAL__ (which is consulted regardless of `ready`, matching the pre-existing AUC path).
    es = _edge_status(
        HIGH_VOL={'calib_slope': 0.81, 'ready': False},
        BEAR={'calib_slope': 0.47, 'ready': True},
        __GLOBAL__={'calib_slope': 0.55},
    )
    assert regime_edge_weight('HIGH_VOL', es) == pytest.approx(0.47)   # collapsed to BEAR
    assert regime_edge_weight('BULL', es) == pytest.approx(0.55)       # no BULL row -> global


def test_the_gate_discriminates_on_the_live_snapshot_instead_of_pinning_every_regime_at_one():
    """Regression for the actual incident, using the real persisted 2026-09-25 values.

    With AUC alone every regime -- and the __GLOBAL__ fallback -- clipped to exactly 1.0, so
    regime_edge_weight() was a constant function and edge_adjusted_probability() a platform-wide
    no-op. The measured slopes from the same panel spread 0.34-0.81. This test is the negative
    control in situ: the first half reproduces the bug from the same fixture the second half fixes.
    """
    live_auc = {'BEAR': 0.5971, 'HIGH_VOL': 0.5700, 'SIDEWAYS': 0.5725, 'CRASH': 0.5938}
    live_slope = {'BEAR': 0.469, 'HIGH_VOL': 0.812, 'SIDEWAYS': 0.346, 'CRASH': 0.339}
    regimes = ('BEAR', 'HIGH_VOL', 'SIDEWAYS', 'CRASH')

    auc_only = _edge_status(
        __GLOBAL__={'auc': 0.6082},
        **{r: {'auc': live_auc[r], 'ready': True} for r in regimes},
    )
    assert {regime_edge_weight(r, auc_only) for r in regimes} == {1.0}, (
        "the AUC path should still reproduce the incident on these values -- if this ever stops "
        "holding, this test has stopped being a negative control"
    )

    with_slope = _edge_status(
        __GLOBAL__={'auc': 0.6082, 'calib_slope': 0.5547},
        **{r: {'auc': live_auc[r], 'calib_slope': live_slope[r], 'ready': True} for r in regimes},
    )
    weights = {r: regime_edge_weight(r, with_slope) for r in regimes}
    assert len(set(weights.values())) == len(regimes), f"weights must discriminate, got {weights}"
    assert max(weights.values()) < 1.0, "every regime measured over-confident; none earns w=1.0"


def test_slope_catches_overconfidence_that_auc_structurally_cannot():
    """The semantic point, in one fixture: PERFECT ordering, still 2x over-confident.

    Winners are scored 0.9 and losers 0.7 on a 50% base rate, so AUC is a flawless 1.0 while the
    probabilities are inflated. d = 0.4/0.2 gives slope = 0.1/0.2 = 0.5 -- halve it. This is the
    HIGH_VOL shape that made the AUC-driven gate grant FULL trust to the most over-confident
    stratum in the live panel (AUC 0.648, mean p 0.790, realized base rate 0.403).
    """
    pairs = [(1, 0.9, 1)] * 200 + [(1, 0.7, 0)] * 200
    res = stratified_calibration_slope(pairs, min_n=50)
    assert res is not None
    assert res['slope'] == pytest.approx(0.5, abs=1e-9)
    assert stratified_auc([(k, p, y) for k, p, y in pairs], min_n=50)['auc'] == pytest.approx(1.0)


def test_slope_is_horizon_stratified_not_pooled():
    """Base rates differ per horizon (38/64/79% live), and a no-intercept slope fitted across
    pooled horizons absorbs that level difference into the slope -- the same trap that made the
    pooled AUC read below every one of its own strata. Each stratum here is internally consistent
    at slope 0.5, so the combined answer must be 0.5, not something the level gap dragged away."""
    pairs = ([(1, 0.9, 1)] * 300 + [(1, 0.7, 0)] * 300      # h=1, base rate 0.50
             + [(15, 0.8, 1)] * 540 + [(15, 0.6, 0)] * 60)  # h=15, base rate 0.90
    res = stratified_calibration_slope(pairs, min_n=50)
    assert set(res['strata']) == {1, 15}
    assert res['strata'][1]['slope'] == pytest.approx(0.5, abs=1e-9)
    # n-weighted mean of the two strata, never a single pooled regression
    expected = sum(v['n'] * v['slope'] for v in res['strata'].values()) / res['n']
    assert res['slope'] == pytest.approx(expected, abs=1e-12)


def test_slope_drops_tiny_and_single_class_strata():
    # Same floors as stratified_auc: a 25-row stratum must not swing the n-weighted mean, and a
    # single-class stratum carries no slope information.
    pairs = ([(5, 0.9, 1)] * 300 + [(5, 0.7, 0)] * 300
             + [(2, 0.99, 1)] * 25                      # tiny
             + [(3, 0.8, 1)] * 400)                     # single class
    res = stratified_calibration_slope(pairs, min_n=50)
    assert set(res['strata']) == {5}
    assert set(res['dropped_strata']) == {2, 3}


def test_regime_edge_weight_not_ready_falls_back_to_global():
    # regime's own AUC looks good but isn't ready (thin data) -> must use global, not the
    # regime's own unproven number
    es = _edge_status(BULL={'auc': 0.90, 'ready': False}, __GLOBAL__={'auc': AUC_RANDOM})
    assert regime_edge_weight('BULL', es) == pytest.approx(0.0)


def test_regime_edge_weight_no_data_passes_through():
    assert regime_edge_weight('BULL', {}) == pytest.approx(1.0)
    es = _edge_status(BEAR={'auc': 0.61, 'ready': True})   # BULL absent entirely, no __GLOBAL__
    assert regime_edge_weight('BULL', es) == pytest.approx(1.0)


def test_regime_edge_weight_high_vol_and_crash_fall_back_to_bear_row_when_own_data_absent():
    # persist_regime_edge_status() may not always have enough HIGH_VOL/CRASH history yet (thin
    # regimes) -- when their OWN row is missing, collapse_regime5 must still route them to the
    # BEAR row, not silently miss and fall through to weight=1.0.
    es = _edge_status(BEAR={'auc': AUC_RANDOM, 'ready': True})
    assert regime_edge_weight('HIGH_VOL', es) == pytest.approx(0.0)
    assert regime_edge_weight('CRASH', es) == pytest.approx(0.0)


def test_regime_edge_weight_high_vol_and_crash_use_their_own_row_when_present():
    # Live bug, 2026-08-10: persist_regime_edge_status() DOES persist a separate row per raw
    # 5-class regime (confirmed live: HIGH_VOL AUC 0.518, CRASH AUC 0.593, distinct from BEAR's
    # 0.61-0.65) -- but regime_edge_weight() used to collapse to the 3-class key BEFORE ever
    # checking edge_status, so it could never actually see HIGH_VOL/CRASH's own row even when
    # persisted, silently borrowing BEAR's (often much higher) trust instead. The prior test's
    # own comment ("HIGH_VOL/CRASH aren't keys in edge_status") documented an assumption that
    # had already gone stale by the time this was found. Own-row-first is now checked, matching
    # what this function's docstring already claimed all along.
    es = _edge_status(
        HIGH_VOL={'auc': AUC_RANDOM, 'ready': True},   # no edge -- must shrink fully
        BEAR={'auc': 0.65, 'ready': True},              # strong edge -- must NOT be borrowed
    )
    assert regime_edge_weight('HIGH_VOL', es) == pytest.approx(0.0)


def test_regime_edge_weight_none_regime_uses_unknown_key():
    es = _edge_status(UNKNOWN={'auc': AUC_RANDOM, 'ready': True})
    assert regime_edge_weight(None, es) == pytest.approx(0.0)


# ── edge_adjusted_probability ─────────────────────────────────────────────────────

def test_edge_adjusted_probability_collapses_to_neutral_when_no_edge():
    es = _edge_status(BULL={'auc': AUC_RANDOM, 'ready': True})
    assert edge_adjusted_probability(0.85, 'BULL', es) == pytest.approx(0.5)
    assert edge_adjusted_probability(0.10, 'BULL', es) == pytest.approx(0.5)


def test_edge_adjusted_probability_passthrough_when_trusted():
    es = _edge_status(BEAR={'auc': 0.61, 'ready': True})
    assert edge_adjusted_probability(0.72, 'BEAR', es) == pytest.approx(0.72)


def test_edge_adjusted_probability_none_returns_none():
    assert edge_adjusted_probability(None, 'BULL', {}) is None


def test_edge_adjusted_probability_realistic_snapshot():
    # mirrors live numbers observed on this project: BEAR has real edge, BULL/SIDEWAYS do not
    es = _edge_status(
        BEAR={'auc': 0.61, 'ready': True},
        BULL={'auc': 0.50, 'ready': True},
        SIDEWAYS={'auc': None, 'ready': False},
        __GLOBAL__={'auc': 0.50},
    )
    assert edge_adjusted_probability(0.70, 'BEAR', es) == pytest.approx(0.70)
    assert edge_adjusted_probability(0.70, 'BULL', es) == pytest.approx(0.5)
    assert edge_adjusted_probability(0.70, 'SIDEWAYS', es) == pytest.approx(0.5)  # falls back to global (0.50)
