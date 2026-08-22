"""
Tests for ml_ensemble.py
"""
import sqlite3
import datetime
import pytest
from pg_test_support import pg_memory_conn  # noqa: E402


def test_load_training_data_includes_stop_loss(monkeypatch):
    """STOP_LOSS outcomes must be mapped to 0 (LOSS), not dropped."""
    import pandas as pd
    from ml_ensemble import load_training_data

    fake_rows = [
        {'symbol': 'A', 'signal_date': '2025-01-10', 'horizon_days': 5,
         'outcome': 'WIN',       'signal_score': 70, 'signals_json': '{}', 'return_pct': 3.0,
         'rsi': 55, 'adx': 22, 'nifty_regime': 'BULL', 'cmp': 100, 'sma200': 95,
         'volume_ratio': 1.2, 'fii_3d_net': 100, 'above_sma200': 1, 'pcr_oi': 1.1,
         'pcr_vol': 1.0, 'fii_10d_net': 200, 'dii_3d_net': 50, 'delivery_pct': 60,
         'sector_ret_5d': 0.5, 'sector_ret_21d': 1.2, 'iv_rank': 0.4, 'iv_skew': 0.1,
         'rs_rank_21d': 0.7, 'rs_rank_63d': 0.6, 'insider_buy_pct_90d': 0.2,
         'opening_range_break': 1, 'vwap_deviation_pct': 0.3, 'first_hour_vol_share': 0.25,
         'fifty_two_week_high': 120, 'piotroski_f_score': 7, 'debt_to_equity': 0.3,
         'operating_margins': 0.18, 'return_on_equity': 0.22, 'revenue_growth': 0.12,
         'earnings_growth': 0.15, 'earnings_yield': 0.05, 'price_to_book': 3.0,
         'market_cap': 1e10, 'n_analysts': 5, 'buy_count': 3, 'target_mean': 115,
         'altman_z': 2.5, 'ohlson_o': -2.0},
        {'symbol': 'B', 'signal_date': '2025-01-10', 'horizon_days': 5,
         'outcome': 'STOP_LOSS', 'signal_score': 65, 'signals_json': '{}', 'return_pct': -4.5,
         'rsi': 40, 'adx': 18, 'nifty_regime': 'BEAR', 'cmp': 200, 'sma200': 210,
         'volume_ratio': 0.8, 'fii_3d_net': -50, 'above_sma200': 0, 'pcr_oi': 0.9,
         'pcr_vol': 0.85, 'fii_10d_net': -100, 'dii_3d_net': 20, 'delivery_pct': 45,
         'sector_ret_5d': -1.0, 'sector_ret_21d': -2.5, 'iv_rank': 0.7, 'iv_skew': -0.2,
         'rs_rank_21d': 0.3, 'rs_rank_63d': 0.25, 'insider_buy_pct_90d': 0.0,
         'opening_range_break': 0, 'vwap_deviation_pct': -0.5, 'first_hour_vol_share': 0.15,
         'fifty_two_week_high': 250, 'piotroski_f_score': 4, 'debt_to_equity': 1.2,
         'operating_margins': 0.08, 'return_on_equity': 0.10, 'revenue_growth': -0.05,
         'earnings_growth': -0.10, 'earnings_yield': 0.03, 'price_to_book': 1.5,
         'market_cap': 5e9, 'n_analysts': 3, 'buy_count': 1, 'target_mean': 220,
         'altman_z': 1.8, 'ohlson_o': -0.5},
    ]

    monkeypatch.setattr('ml_ensemble.read_df', lambda q, p=None: pd.DataFrame(fake_rows))
    df = load_training_data()

    assert len(df) == 2, f"Expected 2 rows, got {len(df)}: STOP_LOSS row should not be dropped"
    stop_row = df[df.index == 1] if 1 in df.index else df.iloc[1:2]
    # STOP_LOSS must be mapped to 0, not NaN
    assert df['outcome'].notna().all(), "STOP_LOSS must be mapped to 0, not NaN/dropped"
    assert df['outcome'].iloc[1] == 0, "STOP_LOSS must map to 0 (LOSS)"


def test_regime_threshold_varies_by_regime(monkeypatch):
    """Threshold must be lower in BEAR regime and higher in CRASH regime."""
    from ml_ensemble import regime_threshold

    class FakeConn:
        def __init__(self, regime): self._regime = regime
        def execute(self, sql, params=()): return self
        def fetchone(self): return (self._regime,)

    assert regime_threshold(FakeConn('BULL'))    == 0.40
    assert regime_threshold(FakeConn('BEAR'))    == 0.36
    assert regime_threshold(FakeConn('HIGH_VOL'))== 0.38
    assert regime_threshold(FakeConn('CRASH'))   == 0.42
    assert regime_threshold(FakeConn('SIDEWAYS'))== 0.40


# ── recommendation_log propagation + expiry gate ────────────────────────────────

def _make_gate_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, win_probability REAL, calibrated_win_probability REAL,
            nifty_regime TEXT, PRIMARY KEY (symbol, date)
        );
        CREATE TABLE recommendation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL, rec_type TEXT NOT NULL, signal_date TEXT NOT NULL,
            generated_at DATETIME NOT NULL, win_probability REAL, nifty_regime TEXT,
            source TEXT DEFAULT 'platform', status TEXT DEFAULT 'ACTIVE'
        );
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    """)
    return conn


def _insert_rec(conn, symbol, signal_date, win_probability=None, status='ACTIVE'):
    conn.execute(
        "INSERT INTO recommendation_log (symbol, rec_type, signal_date, generated_at, "
        "win_probability, source, status) VALUES (?, 'BUY', ?, ?, ?, 'technical_scan', ?)",
        (symbol, signal_date, datetime.datetime.utcnow().isoformat(), win_probability, status),
    )


def test_expiry_gate_uses_calibrated_probability(monkeypatch):
    """Regression for the propagation bug: recommendation_log.win_probability must be filled
    from calibrated_win_probability when present, not the raw (overconfident) win_probability.
    A row with a high raw probability but a low calibrated one must expire."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)  # test DB is sqlite

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability) "
        "VALUES ('CALTEST', ?, 0.60, 0.30)", (today,)
    )
    _insert_rec(conn, 'CALTEST', today)
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute(
        "SELECT win_probability, status FROM recommendation_log WHERE symbol='CALTEST'"
    ).fetchone()
    assert row['win_probability'] == pytest.approx(0.30), \
        "propagation must prefer calibrated_win_probability over raw win_probability"
    assert row['status'] == 'EXPIRED', \
        "0.30 is below every regime threshold (min 0.36) so this must expire"


def test_expiry_gate_falls_back_to_raw_when_uncalibrated(monkeypatch):
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)  # test DB is sqlite

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability) "
        "VALUES ('RAWTEST', ?, 0.70, NULL)", (today,)
    )
    _insert_rec(conn, 'RAWTEST', today)
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute(
        "SELECT win_probability, status FROM recommendation_log WHERE symbol='RAWTEST'"
    ).fetchone()
    assert row['win_probability'] == pytest.approx(0.70)
    assert row['status'] == 'ACTIVE'


# ── flag-gated regime-aware abstention (edge_adjustment_enabled) ───────────────

def _enable_edge_adjustment(conn):
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('edge_adjustment_enabled', 'true')")


def _seed_edge_status(conn, regime, auc, ready=True):
    from ml_calibration import ensure_edge_status_table
    ensure_edge_status_table(conn)
    conn.execute(
        "INSERT INTO regime_edge_status (regime, auc, auc_n, distinct_days, episodes, ready, computed_at) "
        "VALUES (?, ?, 100, 30, 3, ?, datetime('now'))",
        (regime, auc, 1 if ready else 0),
    )


def test_expiry_gate_flag_off_uses_raw_threshold_regardless_of_regime(monkeypatch):
    """Backward compatibility: with the flag off (default), a low-probability BULL row expires
    on raw threshold exactly like before this change, even with a no-edge regime_edge_status
    on record."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    _seed_edge_status(conn, 'BULL', auc=0.50, ready=True)  # no edge, would abstain if flag were on
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('FLAGOFF', ?, 0.20, NULL, 'BULL')", (today,)
    )
    _insert_rec(conn, 'FLAGOFF', today)
    conn.execute("UPDATE recommendation_log SET nifty_regime='BULL' WHERE symbol='FLAGOFF'")
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='FLAGOFF'").fetchone()
    assert row['status'] == 'EXPIRED'


def test_expiry_gate_abstains_in_no_edge_regime_when_flag_on(monkeypatch):
    """With the flag on, a BULL row (proven no live edge, weight=0) with a low win_probability
    but a RECENT signal_date must NOT expire on probability alone -- abstention routes it to the
    same date-cutoff rule NULL rows use, and it isn't old enough to hit that either."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    _enable_edge_adjustment(conn)
    _seed_edge_status(conn, 'BULL', auc=0.50, ready=True)
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('NOEDGE', ?, 0.10, NULL, 'BULL')", (today,)
    )
    _insert_rec(conn, 'NOEDGE', today)
    conn.execute("UPDATE recommendation_log SET nifty_regime='BULL' WHERE symbol='NOEDGE'")
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='NOEDGE'").fetchone()
    assert row['status'] == 'ACTIVE', "no-edge regime must abstain on probability, not expire"


def test_expiry_gate_abstains_then_expires_old_row_via_date_fallback(monkeypatch):
    """Same no-edge regime, but the signal is old (past the 2-day cutoff) -- abstention still
    falls back to the date rule, so it must expire, same as a NULL-probability row would."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    old_date = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
    _enable_edge_adjustment(conn)
    _seed_edge_status(conn, 'BULL', auc=0.50, ready=True)
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('NOEDGEOLD', ?, 0.10, NULL, 'BULL')", (old_date,)
    )
    _insert_rec(conn, 'NOEDGEOLD', old_date)
    conn.execute("UPDATE recommendation_log SET nifty_regime='BULL' WHERE symbol='NOEDGEOLD'")
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='NOEDGEOLD'").fetchone()
    assert row['status'] == 'EXPIRED'


def test_expiry_gate_still_gates_in_edge_regime_when_flag_on(monkeypatch):
    """A BEAR row (proven live edge, weight~1) with low win_probability must still expire on
    probability -- the flag doesn't weaken the one regime that has real edge."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    _enable_edge_adjustment(conn)
    _seed_edge_status(conn, 'BEAR', auc=0.61, ready=True)
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('EDGEBEAR', ?, 0.10, NULL, 'BEAR')", (today,)
    )
    _insert_rec(conn, 'EDGEBEAR', today)
    conn.execute("UPDATE recommendation_log SET nifty_regime='BEAR' WHERE symbol='EDGEBEAR'")
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='EDGEBEAR'").fetchone()
    assert row['status'] == 'EXPIRED'


# ── per-row temporal regime-threshold fix ───────────────────────────────────────
# Regression for a pre-existing bug: the gate used to apply TODAY's current regime threshold
# uniformly to every ACTIVE row, even one created under a different regime days ago. Each row
# must now be judged against the threshold for its OWN stamped nifty_regime.

def test_row_threshold_uses_own_regime_not_current_app_settings_regime(monkeypatch):
    """A BEAR-stamped row (threshold 0.36) with wp=0.38 must survive even though the CURRENT
    app_settings regime is BULL (threshold 0.40, under which 0.38 would have expired the row
    under the old current-regime-only gate)."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('current_nifty_regime', 'BULL')")
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('OWNREGIME', ?, 0.38, NULL, 'BEAR')", (today,)
    )
    _insert_rec(conn, 'OWNREGIME', today)
    conn.execute("UPDATE recommendation_log SET nifty_regime='BEAR' WHERE symbol='OWNREGIME'")
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='OWNREGIME'").fetchone()
    assert row['status'] == 'ACTIVE', \
        "0.38 clears the row's OWN BEAR threshold (0.36) even though current regime is BULL (0.40)"


def test_row_threshold_still_expires_below_own_regime_threshold(monkeypatch):
    """Same BEAR-stamped row, but wp=0.30 -- below even BEAR's own (lower) threshold -- must
    still expire regardless of the current app_settings regime."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('current_nifty_regime', 'BULL')")
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('OWNREGIME2', ?, 0.30, NULL, 'BEAR')", (today,)
    )
    _insert_rec(conn, 'OWNREGIME2', today)
    conn.execute("UPDATE recommendation_log SET nifty_regime='BEAR' WHERE symbol='OWNREGIME2'")
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='OWNREGIME2'").fetchone()
    assert row['status'] == 'EXPIRED'


def test_row_threshold_falls_back_to_current_regime_when_row_regime_missing(monkeypatch):
    """A row with no stamped nifty_regime (NULL) must fall back to today's current regime
    threshold -- unchanged legacy behavior for rows predating regime-stamping."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('current_nifty_regime', 'BEAR')")
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('NOREGIME', ?, 0.38, NULL, NULL)", (today,)
    )
    _insert_rec(conn, 'NOREGIME', today)
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='NOREGIME'").fetchone()
    assert row['status'] == 'ACTIVE', \
        "0.38 clears BEAR's threshold (0.36), the current-regime fallback for a row with no stamped regime"


def test_row_threshold_used_by_edge_adjusted_path_too(monkeypatch):
    """The per-row-regime threshold fix applies identically whether edge_adjustment_enabled is
    on or off -- it's an orthogonal correctness fix, not part of the edge-adjustment feature."""
    import ml_ensemble
    from ml_ensemble import _propagate_and_gate_recommendation_log
    monkeypatch.setattr(ml_ensemble, "use_postgres", lambda: False)

    conn = _make_gate_db()
    today = datetime.date.today().isoformat()
    conn.execute("INSERT INTO app_settings (key, value) VALUES ('current_nifty_regime', 'BULL')")
    _enable_edge_adjustment(conn)
    _seed_edge_status(conn, 'BEAR', auc=0.61, ready=True)   # proven edge -> full trust, no shrink
    conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability, nifty_regime) "
        "VALUES ('OWNREGIMEFLAG', ?, 0.38, NULL, 'BEAR')", (today,)
    )
    _insert_rec(conn, 'OWNREGIMEFLAG', today)
    conn.execute("UPDATE recommendation_log SET nifty_regime='BEAR' WHERE symbol='OWNREGIMEFLAG'")
    conn.commit()

    _propagate_and_gate_recommendation_log(conn)

    row = conn.execute("SELECT status FROM recommendation_log WHERE symbol='OWNREGIMEFLAG'").fetchone()
    assert row['status'] == 'ACTIVE', \
        "same BEAR-threshold logic must apply under the edge-adjusted gate path too"
