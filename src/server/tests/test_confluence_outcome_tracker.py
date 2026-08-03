import sqlite3, sys, os, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from confluence_outcome_tracker import track_outcomes, recompute_screener_reliability  # noqa: E402

SIGNAL_DATE = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()


def make_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE confluence_signals (
            symbol TEXT, computed_at TEXT, current_price REAL, screener_ids_json TEXT
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, close REAL, PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            label_definition TEXT, signal_source TEXT NOT NULL DEFAULT 'unknown',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
        );
        CREATE TABLE trendlyne_screeners (screener_id TEXT PRIMARY KEY, screener_name TEXT);
        CREATE TABLE trendlyne_screener_stocks (screener_id TEXT, symbol TEXT);
        CREATE TABLE moneycontrol_screeners (scan_id TEXT PRIMARY KEY, screener_name TEXT);
        CREATE TABLE moneycontrol_screener_stocks (scan_id TEXT, symbol TEXT);
        CREATE TABLE etnow_screeners (screener_id TEXT PRIMARY KEY, screener_name TEXT);
        CREATE TABLE etnow_screener_stocks (screener_id TEXT, symbol TEXT);
        CREATE TABLE screener_reliability (
            scan_id TEXT PRIMARY KEY, screener_name TEXT, source TEXT,
            total_signals INTEGER DEFAULT 0, wins_7d INTEGER DEFAULT 0,
            win_rate_7d REAL DEFAULT 0, avg_return_7d REAL DEFAULT 0,
            wins_30d INTEGER DEFAULT 0, win_rate_30d REAL DEFAULT 0,
            avg_return_30d REAL DEFAULT 0, max_drawdown REAL DEFAULT 0,
            reliability_score REAL DEFAULT 0, last_updated TEXT
        );
    """)
    return conn


def _seed_confluence_signal(conn, symbol, price=100.0):
    conn.execute(
        "INSERT INTO confluence_signals (symbol, computed_at, current_price, screener_ids_json) "
        "VALUES (?, ?, ?, '[]')",
        (symbol, SIGNAL_DATE, price),
    )


def _seed_close(conn, symbol, horizon_days, close):
    d = (datetime.date.fromisoformat(SIGNAL_DATE) + datetime.timedelta(days=horizon_days)).isoformat()
    conn.execute("INSERT INTO stock_ohlcv (symbol, date, close) VALUES (?, ?, ?)", (symbol, d, close))


# ─── writer: signal_source / label_definition stamping (2026-08 fix) ──────────────

def test_track_outcomes_stamps_confluence_source_and_terminal_pct2_label():
    conn = make_db()
    _seed_confluence_signal(conn, 'AAA')
    for h in (1, 3, 7, 14, 30):
        _seed_close(conn, 'AAA', h, 105.0)  # +5% -> WIN under the fixed +/-2% barrier
    conn.commit()

    tracked = track_outcomes(conn)
    assert tracked == 5

    rows = conn.execute(
        "SELECT horizon_days, outcome, signal_source, label_definition FROM signal_outcomes "
        "WHERE symbol='AAA' ORDER BY horizon_days"
    ).fetchall()
    assert len(rows) == 5
    for r in rows:
        assert r['signal_source'] == 'confluence'
        assert r['label_definition'] == 'terminal_pct2'
        assert r['outcome'] == 'WIN'


def test_track_outcomes_uses_fixed_2pct_barrier():
    conn = make_db()
    _seed_confluence_signal(conn, 'BBB')
    _seed_close(conn, 'BBB', 7, 101.5)   # +1.5% -> NEUTRAL (inside +/-2%)
    _seed_close(conn, 'BBB', 14, 98.5)   # -1.5% -> NEUTRAL
    _seed_close(conn, 'BBB', 30, 97.0)   # -3.0% -> LOSS
    conn.commit()

    track_outcomes(conn)

    out = {r['horizon_days']: r['outcome'] for r in conn.execute(
        "SELECT horizon_days, outcome FROM signal_outcomes WHERE symbol='BBB'"
    ).fetchall()}
    assert out[7] == 'NEUTRAL'
    assert out[14] == 'NEUTRAL'
    assert out[30] == 'LOSS'


# ─── the actual bug: dedup must be source-scoped, not global (2026-08 fix) ────────

def test_track_outcomes_does_not_skip_a_horizon_already_claimed_by_technical_source():
    """Before the fix, confluence_outcome_tracker's existing_outcomes check matched ANY row
    for (symbol, signal_date, horizon_days) regardless of writer -- so if outcome_resolver.py
    had already written a 'technical' row for this exact key, this script silently skipped
    writing its OWN confluence-sourced row. The fix scopes the pre-check to signal_source, so
    both can coexist."""
    conn = make_db()
    # Simulate outcome_resolver.py having already resolved h1 for this (symbol, date) as
    # 'technical' -- same PK-relevant fields, different signal_source.
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "signal_source, label_definition) VALUES ('CCC', ?, 1, 100.0, 'WIN', 'technical', 'path_barrier')",
        (SIGNAL_DATE,),
    )
    _seed_confluence_signal(conn, 'CCC')
    _seed_close(conn, 'CCC', 1, 103.0)  # would be WIN under the confluence +/-2% barrier too
    conn.commit()

    tracked = track_outcomes(conn)

    assert tracked == 1, "confluence-sourced h1 row must be written even though a technical-sourced h1 row already exists"
    rows = conn.execute(
        "SELECT signal_source, outcome FROM signal_outcomes WHERE symbol='CCC' AND horizon_days=1 ORDER BY signal_source"
    ).fetchall()
    assert [r['signal_source'] for r in rows] == ['confluence', 'technical']


# ─── recompute_screener_reliability must not blend technical-sourced rows ─────────

def test_recompute_screener_reliability_only_counts_confluence_source():
    conn = make_db()
    conn.execute("INSERT INTO etnow_screeners (screener_id, screener_name) VALUES ('et-1', 'Test Screener')")
    conn.execute("INSERT INTO etnow_screener_stocks (screener_id, symbol) VALUES ('et-1', 'DDD')")

    # A technical-sourced row at h7 with an opposite outcome to what the confluence row says --
    # if the query doesn't filter by signal_source, this would corrupt the reliability score.
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source) VALUES ('DDD', ?, 7, 100.0, 'LOSS', -20.0, 'technical')",
        (SIGNAL_DATE,),
    )
    conn.execute(
        "INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, entry_price, outcome, "
        "return_pct, signal_source) VALUES ('DDD', ?, 7, 100.0, 'WIN', 5.0, 'confluence')",
        (SIGNAL_DATE,),
    )
    conn.commit()

    recompute_screener_reliability(conn)

    row = conn.execute("SELECT total_signals, wins_7d, win_rate_7d FROM screener_reliability WHERE scan_id='et-1'").fetchone()
    assert row['total_signals'] == 1, "must only count the confluence-sourced row, not both"
    assert row['wins_7d'] == 1
    assert row['win_rate_7d'] == 1.0
