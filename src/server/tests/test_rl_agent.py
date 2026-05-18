import sqlite3, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def make_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE rl_q_table (
            state_key TEXT NOT NULL, action TEXT NOT NULL,
            q_value REAL NOT NULL DEFAULT 0.0,
            visit_count INTEGER NOT NULL DEFAULT 0,
            last_updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (state_key, action)
        );
        CREATE TABLE rl_episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL, state_key TEXT NOT NULL,
            action_taken TEXT NOT NULL, reward REAL,
            epsilon REAL, notes TEXT
        );
        CREATE TABLE app_settings (
            key TEXT PRIMARY KEY, value TEXT,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
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
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER,
            PRIMARY KEY (symbol, date)
        );
    """)
    return conn

def test_get_state_key():
    from rl_agent import get_state_key
    assert get_state_key('BULL', 'IT', 8)   == 'BULL_IT_HIGH'
    assert get_state_key('BEAR', 'BANK', 4) == 'BEAR_BANK_LOW'
    assert get_state_key('SIDEWAYS', 'PHARMA', 2) == 'SIDEWAYS_PHARMA_LOW'

def test_get_sector_bucket():
    from rl_agent import get_sector_bucket
    assert get_sector_bucket('Information Technology') == 'IT'
    assert get_sector_bucket('Banking')                == 'BANK'
    assert get_sector_bucket('Pharmaceuticals')        == 'PHARMA'
    assert get_sector_bucket('Textile')                == 'OTHER'
    assert get_sector_bucket(None)                     == 'OTHER'

def test_get_score_bucket():
    from rl_agent import get_score_bucket
    assert get_score_bucket(3)  == 'LOW'
    assert get_score_bucket(5)  == 'LOW'
    assert get_score_bucket(6)  == 'MED'
    assert get_score_bucket(7)  == 'MED'
    assert get_score_bucket(8)  == 'HIGH'
    assert get_score_bucket(10) == 'HIGH'

def test_q_learning_update_increases_q():
    from rl_agent import q_update, get_q, set_q
    conn = make_db()
    state  = 'BULL_IT_HIGH'
    action = 'AGGRESSIVE'
    old_q  = get_q(conn, state, action)
    assert old_q == 0.0
    new_q  = q_update(old_q=old_q, reward=2.0, next_max_q=0.0, alpha=0.1, gamma=0.85)
    set_q(conn, state, action, new_q)
    assert get_q(conn, state, action) > 0.0

def test_q_learning_negative_reward_decreases_q():
    from rl_agent import q_update
    q_after_bad = q_update(old_q=1.0, reward=-3.0, next_max_q=0.0, alpha=0.1, gamma=0.85)
    assert q_after_bad < 1.0

def test_get_policy_returns_valid_action():
    from rl_agent import get_policy, ACTIONS
    conn = make_db()
    action = get_policy(conn, 'BULL_IT_HIGH', epsilon=0.0)
    assert action in ACTIONS

def test_get_multipliers_returns_dict():
    from rl_agent import get_multipliers, ACTIONS
    for action in ACTIONS:
        m = get_multipliers(action)
        assert isinstance(m, dict)
        for k, v in m.items():
            assert isinstance(k, str)
            assert 0.5 <= v <= 2.0, f"{action} multiplier {k}={v} out of range"
