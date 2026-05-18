import sqlite3, sys, os, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def make_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, cmp REAL, signal_score INTEGER,
            signals_json TEXT, stop_loss TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
    """)
    return conn

def test_win_outcome():
    conn = make_db()
    signal_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    exit_date   = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
    conn.execute("INSERT INTO technical_signals VALUES (?,?,100.0,7,'[]','90.0')",
                 ('RELIANCE', signal_date))
    conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,102,105,99,103,1000000)",
                 ('RELIANCE', exit_date))
    conn.commit()

    from outcome_resolver import resolve_outcomes
    result = resolve_outcomes(conn, horizon_days=15, dry_run=False)
    assert result['resolved'] >= 1

    row = conn.execute(
        "SELECT outcome, return_pct FROM signal_outcomes WHERE symbol='RELIANCE'"
    ).fetchone()
    assert row is not None
    assert row[0] == 'WIN'
    assert row[1] > 1.0

def test_stop_loss_outcome():
    conn = make_db()
    signal_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    sl_hit_date = (datetime.date.today() - datetime.timedelta(days=17)).isoformat()
    conn.execute("INSERT INTO technical_signals VALUES (?,?,100.0,6,'[]','90.0')",
                 ('TCS', signal_date))
    conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,98,99,89,97,500000)",
                 ('TCS', sl_hit_date))
    conn.commit()

    from outcome_resolver import resolve_outcomes
    result = resolve_outcomes(conn, horizon_days=15, dry_run=False)
    assert result['resolved'] >= 1

    row = conn.execute(
        "SELECT outcome FROM signal_outcomes WHERE symbol='TCS'"
    ).fetchone()
    assert row is not None
    assert row[0] == 'STOP_LOSS'

def test_dry_run_writes_nothing():
    conn = make_db()
    signal_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    exit_date   = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
    conn.execute("INSERT INTO technical_signals VALUES (?,?,100.0,5,'[]',NULL)",
                 ('INFY', signal_date))
    conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,110,112,108,111,200000)",
                 ('INFY', exit_date))
    conn.commit()

    from outcome_resolver import resolve_outcomes
    resolve_outcomes(conn, horizon_days=15, dry_run=True)

    count = conn.execute("SELECT COUNT(*) FROM signal_outcomes").fetchone()[0]
    assert count == 0
