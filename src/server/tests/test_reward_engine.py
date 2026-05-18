import sqlite3, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def make_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, nifty_regime TEXT, signals_json TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, sector TEXT);
        CREATE TABLE signal_type_weights (
            id INTEGER PRIMARY KEY,
            signal_type TEXT NOT NULL, regime TEXT NOT NULL,
            sector TEXT NOT NULL DEFAULT 'ALL',
            weight REAL NOT NULL DEFAULT 1.0,
            sample_count INTEGER NOT NULL DEFAULT 0,
            last_updated TEXT NOT NULL,
            UNIQUE(signal_type, regime, sector)
        );
        CREATE TABLE feature_importance_log (
            id INTEGER PRIMARY KEY, model_id INTEGER,
            model_name TEXT, computed_at TEXT,
            feature_name TEXT, importance REAL, rank_position INTEGER
        );
    """)
    return conn

def insert_outcome(conn, symbol, date, return_pct, outcome, regime='BULL',
                   signals='[{"type":"RSI_DIVERGENCE"}]', sector='IT'):
    conn.execute("""
        INSERT OR IGNORE INTO signal_outcomes
        VALUES (?,?,15,100.0,?,?,?,?,6,?,CURRENT_TIMESTAMP)
    """, (symbol, date, date, 100*(1+return_pct/100), return_pct, outcome, signals))
    conn.execute("""
        INSERT OR IGNORE INTO technical_signals VALUES (?,?,?,?)
    """, (symbol, date, regime, signals))
    conn.execute("INSERT OR IGNORE INTO nse_stocks VALUES (?,?)", (symbol, sector))
    conn.commit()

def test_win_increases_weight():
    conn = make_db()
    insert_outcome(conn, 'INFY', '2024-01-01', 5.0, 'WIN')
    insert_outcome(conn, 'INFY', '2024-01-02', 5.0, 'WIN')
    insert_outcome(conn, 'INFY', '2024-01-03', 5.0, 'WIN')

    from reward_engine import update_weights
    update_weights(conn, dry_run=False)

    row = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='RSI_DIVERGENCE' AND regime='BULL' AND sector='IT'
    """).fetchone()
    assert row is not None
    assert row[0] > 1.0, f"Expected weight > 1.0, got {row[0]}"

def test_stop_loss_decreases_weight_more_than_loss():
    conn = make_db()
    insert_outcome(conn, 'TCS', '2024-01-02', -3.0, 'LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn, 'TCS', '2024-01-03', -3.0, 'LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn, 'TCS', '2024-01-04', -3.0, 'LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    from reward_engine import update_weights
    update_weights(conn, dry_run=False)
    loss_weight = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='MACD_CROSSOVER' AND regime='BULL' AND sector='IT'
    """).fetchone()[0]

    conn2 = make_db()
    insert_outcome(conn2, 'WIPRO', '2024-01-02', -3.0, 'STOP_LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn2, 'WIPRO', '2024-01-03', -3.0, 'STOP_LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn2, 'WIPRO', '2024-01-04', -3.0, 'STOP_LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    update_weights(conn2, dry_run=False)
    sl_weight = conn2.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='MACD_CROSSOVER' AND regime='BULL' AND sector='IT'
    """).fetchone()[0]

    assert sl_weight < loss_weight, "STOP_LOSS should reduce weight more than plain LOSS"

def test_weight_clamped_to_floor():
    conn = make_db()
    # Pre-seed weight at 0.32 for (RSI_DIVERGENCE, BULL, IT) — matching the outcome's sector
    conn.execute("""
        INSERT INTO signal_type_weights
        (signal_type, regime, sector, weight, sample_count, last_updated)
        VALUES ('RSI_DIVERGENCE','BULL','IT',0.32,5,CURRENT_TIMESTAMP)
    """)
    conn.commit()
    # Insert 3 outcomes (MIN_SAMPLES=3) with massive STOP_LOSS to drive weight toward floor
    for i, sym in enumerate(['X1', 'X2', 'X3']):
        insert_outcome(conn, sym, f'2024-01-0{i+1}', -20.0, 'STOP_LOSS')
    from reward_engine import update_weights
    update_weights(conn, dry_run=False)
    row = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='RSI_DIVERGENCE' AND regime='BULL' AND sector='IT'
    """).fetchone()
    assert row is not None
    assert row[0] >= 0.3, f"Weight should not go below 0.3, got {row[0]}"

def test_dry_run_no_writes():
    conn = make_db()
    insert_outcome(conn, 'HDFCBANK', '2024-01-01', 8.0, 'WIN',
                   signals='[{"type":"GOLDEN_CROSS"}]')
    insert_outcome(conn, 'HDFCBANK', '2024-01-02', 8.0, 'WIN',
                   signals='[{"type":"GOLDEN_CROSS"}]')
    insert_outcome(conn, 'HDFCBANK', '2024-01-03', 8.0, 'WIN',
                   signals='[{"type":"GOLDEN_CROSS"}]')
    from reward_engine import update_weights
    update_weights(conn, dry_run=True)
    count = conn.execute("SELECT COUNT(*) FROM signal_type_weights").fetchone()[0]
    assert count == 0
