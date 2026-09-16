import sqlite3, sys, os, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

# update_weights() filters signal_date >= now() - DEFAULT_WINDOW_DAYS (180). The hardcoded
# 2024-01-0X dates this file used to insert are now (2026) far outside that window, so every
# test silently hit reward_engine's "No resolved outcomes found" early-return -- 2 tests failed
# outright, and the other 2 (test_weight_clamped_to_floor, test_dry_run_no_writes) passed
# vacuously without ever exercising update_weights' row-processing path. Use dates relative to
# today so the fixture stays valid regardless of when the suite runs.
def _d(days_ago: int) -> str:
    return (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()

def make_db():
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            -- update_weights() filters signal_outcomes to signal_source='technical' (2026-08
            -- fix, complementing its own unified_signal_outcomes NOT IN ('technical',
            -- 'technical_scan') half of the same UNION); default so insert_outcome()'s
            -- positional INSERT below still works.
            signal_source TEXT NOT NULL DEFAULT 'technical',
            PRIMARY KEY (symbol, signal_date, horizon_days, signal_source)
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
        CREATE TABLE unified_signal_outcomes (
            id INTEGER PRIMARY KEY, unified_signal_id INTEGER,
            symbol TEXT, signal_date TEXT, signal_source TEXT,
            horizon_days INTEGER, return_pct REAL, outcome TEXT
        );
        -- update_source_weights JOINs outcomes back to their signal row, and writes per-source
        -- weights here. This is where AI/screener outcomes are learned from; update_weights
        -- deliberately reads signal_outcomes only (technical pattern types).
        CREATE TABLE unified_signals (
            id INTEGER PRIMARY KEY, symbol TEXT, signal_date TEXT,
            signal_source TEXT, signal_type TEXT
        );
        CREATE TABLE signal_source_weights (
            signal_source TEXT NOT NULL, regime TEXT NOT NULL,
            sector TEXT NOT NULL DEFAULT 'ALL',
            win_rate REAL, avg_return_pct REAL, total_signals INTEGER,
            total_wins INTEGER, total_losses INTEGER, avg_sharpe_ratio REAL,
            weight_multiplier REAL NOT NULL DEFAULT 1.0, last_updated TEXT,
            PRIMARY KEY (signal_source, regime, sector)
        );
        CREATE TABLE signal_type_weights_history (
            snapshot_date TEXT NOT NULL, signal_type TEXT NOT NULL,
            regime TEXT NOT NULL, sector TEXT NOT NULL DEFAULT 'ALL',
            weight REAL NOT NULL DEFAULT 1.0, sample_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (snapshot_date, signal_type, regime, sector)
        );
    """)
    return conn

def insert_outcome(conn, symbol, date, return_pct, outcome, regime='BULL',
                   signals='[{"type":"RSI_DIVERGENCE"}]', sector='IT'):
    conn.execute("""
        INSERT OR IGNORE INTO signal_outcomes
        (symbol, signal_date, horizon_days, entry_price, check_date, exit_price,
         return_pct, outcome, signal_score, signals_json, computed_at)
        VALUES (?,?,15,100.0,?,?,?,?,6,?,CURRENT_TIMESTAMP)
    """, (symbol, date, date, 100*(1+return_pct/100), return_pct, outcome, signals))
    conn.execute("""
        INSERT OR IGNORE INTO technical_signals VALUES (?,?,?,?)
    """, (symbol, date, regime, signals))
    conn.execute("INSERT OR IGNORE INTO nse_stocks VALUES (?,?)", (symbol, sector))
    conn.commit()

def test_win_increases_weight():
    conn = make_db()
    insert_outcome(conn, 'INFY', _d(3), 5.0, 'WIN')
    insert_outcome(conn, 'INFY', _d(2), 5.0, 'WIN')
    insert_outcome(conn, 'INFY', _d(1), 5.0, 'WIN')

    from reward_engine import update_weights
    update_weights(conn, dry_run=False)

    row = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='RSI_DIVERGENCE' AND regime='BULL' AND sector='IT'
    """).fetchone()
    assert row is not None
    assert row[0] > 1.0, f"Expected weight > 1.0, got {row[0]}"

def test_technical_sourced_unified_outcomes_are_not_double_counted():
    """Every technical-sourced outcome reaches update_weights via the signal_outcomes half of
    its UNION. The unified_signal_outcomes half must contribute only NON-technical sources.

    The exclusion listed 'TECHNICAL' alone, so when Cluster B-lite folded
    technical_analysis_engine.py into unified_signals under the lowercase 'technical' spelling,
    25,740 technical outcomes started leaking into the AI/QUANT half and were counted twice.
    Two spellings differing only by case is what made the bug invisible.
    """
    from reward_engine import update_weights

    def run(extra_sources):
        conn = make_db()
        insert_outcome(conn, 'INFY', _d(3), 5.0, 'WIN')
        insert_outcome(conn, 'INFY', _d(2), 5.0, 'WIN')
        insert_outcome(conn, 'INFY', _d(1), 5.0, 'WIN')
        for src in extra_sources:
            conn.execute(
                "INSERT INTO unified_signal_outcomes "
                "(symbol, signal_date, signal_source, horizon_days, return_pct, outcome) "
                "VALUES (?,?,?,15,-9.0,'LOSS')", ('INFY', _d(1), src))
        conn.commit()
        return update_weights(conn, dry_run=False)['processed']

    # update_weights reads signal_outcomes ONLY, so NO unified_signal_outcomes row of any source
    # reaches it -- and `processed` no longer overstates what was actually used. Asserting on
    # every source, including AI, is the point: the old query admitted AI rows and then silently
    # discarded them, which is what made `processed` a lie.
    baseline = run([])
    assert baseline == 3
    for src in ('technical', 'technical_scan', 'AI', 'screener', 'SCREENER_SURFACING'):
        assert run([src]) == 3, f"unified_signal_outcomes source {src!r} reached update_weights"


def test_per_source_learning_lives_in_update_source_weights():
    """The counterpart to the test above: removing the dead UNION half must not mean AI/screener
    outcomes stop being learned from. They were never learned from THERE -- update_weights keys
    on technical pattern types (RSI_DIVERGENCE, GOLDEN_CROSS, ...) parsed from signals_json, and
    unified_signal_outcomes has no column that could supply one.

    update_source_weights() is the correct home: it groups unified_signal_outcomes by
    (signal_source, regime, sector) and writes signal_source_weights. This asserts the AI row
    that update_weights correctly ignores IS picked up here, so the deletion moved nothing into
    a blind spot.
    """
    from reward_engine import update_source_weights, MIN_SAMPLES as _MIN_SAMPLES

    conn = make_db()
    # update_source_weights JOINs unified_signal_outcomes -> unified_signals on id, so the
    # signal row has to exist for the outcome to be visible.
    for i in range(_MIN_SAMPLES):
        conn.execute(
            "INSERT INTO unified_signals (id, symbol, signal_date, signal_source, signal_type) "
            "VALUES (?,?,?,?,?)", (i + 1, 'INFY', _d(1), 'AI', 'BUY'))
        conn.execute(
            "INSERT INTO unified_signal_outcomes "
            "(unified_signal_id, symbol, signal_date, signal_source, horizon_days, return_pct, outcome) "
            "VALUES (?,?,?,?,15,4.0,'WIN')", (i + 1, 'INFY', _d(1), 'AI'))
    conn.execute("INSERT OR IGNORE INTO nse_stocks VALUES ('INFY','IT')")
    conn.commit()

    res = update_source_weights(conn, dry_run=False)
    assert res['processed'] == _MIN_SAMPLES, res
    row = conn.execute(
        "SELECT signal_source, win_rate FROM signal_source_weights "
        "WHERE signal_source='AI'").fetchone()
    assert row is not None, 'AI outcomes were not learned from anywhere'
    assert row[1] == 1.0, f'expected a 1.0 win_rate from all-WIN rows, got {row[1]}'


def test_stop_loss_decreases_weight_more_than_loss():
    conn = make_db()
    insert_outcome(conn, 'TCS', _d(3), -3.0, 'LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn, 'TCS', _d(2), -3.0, 'LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn, 'TCS', _d(1), -3.0, 'LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    from reward_engine import update_weights
    update_weights(conn, dry_run=False)
    loss_weight = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='MACD_CROSSOVER' AND regime='BULL' AND sector='IT'
    """).fetchone()[0]

    conn2 = make_db()
    insert_outcome(conn2, 'WIPRO', _d(3), -3.0, 'STOP_LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn2, 'WIPRO', _d(2), -3.0, 'STOP_LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    insert_outcome(conn2, 'WIPRO', _d(1), -3.0, 'STOP_LOSS',
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
        insert_outcome(conn, sym, _d(i + 1), -20.0, 'STOP_LOSS')
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
    insert_outcome(conn, 'HDFCBANK', _d(3), 8.0, 'WIN',
                   signals='[{"type":"GOLDEN_CROSS"}]')
    insert_outcome(conn, 'HDFCBANK', _d(2), 8.0, 'WIN',
                   signals='[{"type":"GOLDEN_CROSS"}]')
    insert_outcome(conn, 'HDFCBANK', _d(1), 8.0, 'WIN',
                   signals='[{"type":"GOLDEN_CROSS"}]')
    from reward_engine import update_weights
    update_weights(conn, dry_run=True)
    count = conn.execute("SELECT COUNT(*) FROM signal_type_weights").fetchone()[0]
    assert count == 0
