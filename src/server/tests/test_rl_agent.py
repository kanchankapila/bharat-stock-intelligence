import sys
import os
import sqlite3
import datetime
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.rl_agent import (
    _get_nifty_return, _get_nifty_horizon_return,
    _get_next_state_key, daily_update, REGIMES,
)


def _make_test_conn():
    conn = sqlite3.connect(':memory:')
    conn.execute("""
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date DATE, open REAL, high REAL, low REAL, close REAL, volume INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE market_regimes (
            date TEXT PRIMARY KEY, regime TEXT, regime_prob REAL, hmm_state INTEGER,
            viterbi_path_json TEXT, features_json TEXT, computed_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE rl_q_table (
            state_key TEXT, action TEXT, q_value REAL, visit_count INTEGER, last_updated TEXT,
            PRIMARY KEY (state_key, action)
        )
    """)
    conn.execute("""
        CREATE TABLE rl_episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, state_key TEXT,
            action_taken TEXT, reward REAL, epsilon REAL
        )
    """)
    conn.execute("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            outcome TEXT, return_pct REAL, signal_score INTEGER,
            -- rl_agent.py filters to signal_source='technical' (2026-08 fix); default so the
            -- existing positional 6-col INSERTs below don't need touching.
            signal_source TEXT NOT NULL DEFAULT 'technical'
        )
    """)
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, nifty_regime TEXT, signal_score INTEGER,
            cmp REAL, stop_loss REAL, signals_json TEXT, adx REAL
        )
    """)
    # "updatedAt" quoted: production's column is mixed-case, and rl_agent.py's INSERT quotes it.
    # Unquoted here, Postgres folds it to `updatedat` and that INSERT can never find it.
    conn.execute('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, "updatedAt" TIMESTAMPTZ)')
    # Populate 25 days of Nifty OHLCV starting 2024-01-25
    # close on day i = 21000 + i*10
    from datetime import date, timedelta
    start = date(2024, 1, 25)
    for i in range(25):
        d = (start + timedelta(days=i)).isoformat()
        close = 21000.0 + i * 10
        conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)",
                     ('NIFTY50', d, close - 5, close + 5, close - 10, close, 1_000_000))
    conn.commit()
    return conn


class TestNiftyHorizonReturn:
    """_get_nifty_horizon_return must measure the FORWARD window: entry → entry+horizon_days."""

    def test_horizon_return_forward_window(self):
        conn = _make_test_conn()
        # Entry: 2024-01-25 (i=0), close = 21000
        # Exit:  2024-02-09 (i=15), close = 21000 + 15*10 = 21150
        # Expected return ≈ (21150 - 21000) / 21000 * 100 ≈ 0.714%
        ret = _get_nifty_horizon_return(conn, '2024-01-25', horizon_days=15)
        assert abs(ret - 0.714) < 0.05, f"Expected ~0.714% forward return, got {ret:.4f}"

    def test_horizon_return_positive_in_uptrend(self):
        conn = _make_test_conn()
        ret = _get_nifty_horizon_return(conn, '2024-01-25', horizon_days=15)
        assert ret > 0

    def test_horizon_return_exceeds_1day(self):
        conn = _make_test_conn()
        ret_1d  = _get_nifty_return(conn, '2024-01-26')   # 1-day return at day 2
        ret_15d = _get_nifty_horizon_return(conn, '2024-01-25', horizon_days=15)
        assert ret_15d > ret_1d, (
            f"15-day forward return ({ret_15d:.4f}) should exceed 1-day return ({ret_1d:.4f})"
        )


class TestNextStateTransition:
    def test_next_state_reflects_resolution_regime(self):
        conn = _make_test_conn()
        # sig_date 2024-01-31 + 15 days = 2024-02-15
        conn.execute("INSERT INTO market_regimes VALUES (?,?,?,?,?,?,?)",
                     ('2024-02-15', 'BEAR', 0.85, 3, '[]', '{}', '2024-02-15'))
        conn.commit()

        next_state = _get_next_state_key(conn, 'BULL_BANK_HIGH', '2024-01-31', horizon_days=15)
        assert next_state.startswith('BEAR_'), (
            f"Expected next state regime=BEAR, got: {next_state}"
        )

    def test_next_state_keeps_sector_and_score_bucket(self):
        conn = _make_test_conn()
        conn.execute("INSERT INTO market_regimes VALUES (?,?,?,?,?,?,?)",
                     ('2024-02-15', 'SIDEWAYS', 0.7, 1, '[]', '{}', '2024-02-15'))
        conn.commit()

        next_state = _get_next_state_key(conn, 'BULL_IT_LOW', '2024-01-31', horizon_days=15)
        parts = next_state.split('_')
        assert parts[0] == 'SIDEWAYS'
        assert parts[1] == 'IT'
        assert parts[2] == 'LOW'

    def test_fallback_to_current_state_when_no_regime_data(self):
        conn = _make_test_conn()
        result = _get_next_state_key(conn, 'BULL_BANK_MED', '2024-01-31', horizon_days=15)
        assert result == 'BULL_BANK_MED'

    def test_malformed_state_key_returns_unchanged(self):
        conn = _make_test_conn()
        conn.execute("INSERT INTO market_regimes VALUES (?,?,?,?,?,?,?)",
                     ('2024-02-15', 'BEAR', 0.85, 3, '[]', '{}', '2024-02-15'))
        conn.commit()
        result = _get_next_state_key(conn, 'BULL', '2024-01-31', horizon_days=15)
        assert result == 'BULL', "Malformed key with wrong part count must be returned unchanged"


class TestDailyUpdateLooksBack:
    def test_daily_update_queries_horizon_days_back(self):
        conn = _make_test_conn()
        target_date = (datetime.date.today() - datetime.timedelta(days=15)).isoformat()

        conn.execute(
            "INSERT INTO rl_episodes (date, state_key, action_taken, epsilon) VALUES (?,?,?,?)",
            (target_date, 'BULL_IT_HIGH', 'AGGRESSIVE', 0.1)
        )
        conn.execute(
            "INSERT INTO signal_outcomes "
            "(symbol, signal_date, horizon_days, outcome, return_pct, signal_score) "
            "VALUES (?,?,?,?,?,?)",
            ('INFY', target_date, 15, 'WIN', 8.5, 7)
        )
        conn.execute(
            "INSERT INTO technical_signals VALUES (?,?,?,?,?,?,?,?)",
            ('INFY', target_date, 'BULL', 7, 1500.0, 1400.0, '[]', 30.0)
        )
        conn.commit()

        result = daily_update(conn, dry_run=True, horizon_days=15)
        assert result['updated'] > 0

    def test_daily_update_writes_reward_to_episode(self):
        """Non-dry-run: episode reward must be written to the DB."""
        conn = _make_test_conn()
        target_date = (datetime.date.today() - datetime.timedelta(days=15)).isoformat()

        conn.execute(
            "INSERT INTO rl_episodes (date, state_key, action_taken, epsilon) VALUES (?,?,?,?)",
            (target_date, 'BULL_IT_HIGH', 'AGGRESSIVE', 0.1)
        )
        conn.execute(
            "INSERT INTO signal_outcomes "
            "(symbol, signal_date, horizon_days, outcome, return_pct, signal_score) "
            "VALUES (?,?,?,?,?,?)",
            ('INFY', target_date, 15, 'WIN', 8.5, 7)
        )
        conn.execute(
            "INSERT INTO technical_signals VALUES (?,?,?,?,?,?,?,?)",
            ('INFY', target_date, 'BULL', 7, 1500.0, 1400.0, '[]', 30.0)
        )
        conn.commit()

        daily_update(conn, dry_run=False, horizon_days=15)

        row = conn.execute("SELECT reward FROM rl_episodes WHERE date = ?", (target_date,)).fetchone()
        assert row is not None
        assert row[0] is not None, "Episode reward must be written after non-dry-run daily_update"
