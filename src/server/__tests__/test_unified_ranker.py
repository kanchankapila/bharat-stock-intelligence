import sqlite3
import csv
import os
import sys
import tempfile
import pytest

# Add src/server to path so we can import unified_ranker
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


def make_db():
    """Create in-memory SQLite with required tables."""
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.executescript('''
        CREATE TABLE screener_catalog (
            screener_id TEXT NOT NULL, source TEXT NOT NULL,
            screener_name TEXT NOT NULL, category TEXT NOT NULL,
            subcategory TEXT, signal_bias TEXT NOT NULL,
            investment_horizon TEXT, confidence REAL NOT NULL,
            score_0_100 REAL, tier TEXT, sub_mod REAL, horiz_mult REAL,
            PRIMARY KEY (screener_id, source)
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT NOT NULL, stock_id TEXT NOT NULL, symbol TEXT,
            PRIMARY KEY (screener_id, stock_id)
        );
        CREATE TABLE moneycontrol_screener_stocks (
            scan_id TEXT NOT NULL, mcsymbol TEXT NOT NULL,
            stock_name TEXT, symbol TEXT,
            PRIMARY KEY (scan_id, mcsymbol)
        );
        CREATE TABLE etnow_screener_stocks (
            screener_id TEXT NOT NULL, symbol TEXT NOT NULL,
            stock_name TEXT, PRIMARY KEY (screener_id, symbol)
        );
        CREATE TABLE stock_scores (
            symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
            composite_score REAL, PRIMARY KEY (symbol, timeframe)
        );
        CREATE TABLE market_regimes (
            date TEXT PRIMARY KEY, regime TEXT NOT NULL,
            regime_prob REAL, computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE recommendation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL, signal_date TEXT NOT NULL,
            entry_price REAL, actual_return_pct REAL, outcome TEXT,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE technical_analysis_signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT,
            date TEXT, win_probability REAL, signal_score REAL
        );
        CREATE TABLE unified_recommendations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL, computed_at TEXT NOT NULL,
            regime TEXT NOT NULL, unified_score REAL NOT NULL,
            conviction_level TEXT NOT NULL, screener_stock_score REAL,
            ml_score REAL, confluence_score REAL, technical_score REAL,
            dl_score REAL, avg_engine_track_record REAL,
            bullish_screener_count INTEGER, bearish_screener_count INTEGER,
            screener_names_json TEXT, fundamental_score REAL,
            entry_zone_low REAL, entry_zone_high REAL, stop_loss REAL,
            target_1 REAL, target_2 REAL, target_3 REAL,
            risk_reward REAL, timeframe TEXT, sector TEXT,
            trade_reasoning TEXT, UNIQUE(symbol, computed_at)
        );
        CREATE TABLE signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT,
            entry_price REAL, stop_loss REAL,
            target_1 REAL, target_2 REAL, target_3 REAL,
            risk_reward REAL, timeframe TEXT, trade_reasoning TEXT,
            sector TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    ''')
    return conn


def make_csv(rows):
    """Write rows to a temp CSV file; return path."""
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False, newline='')
    fieldnames = ['source','screener_id','screener_name','category',
                  'subcategory','signal_bias','investment_horizon','confidence']
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)
    f.close()
    return f.name


class TestScreenerCatalogSeed:
    def test_seed_loads_rows_from_csv(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'s1','screener_name':'Bull Breakout',
             'category':'technical_breakout','subcategory':'price_breakout',
             'signal_bias':'bullish','investment_horizon':'swing','confidence':'0.74'},
            {'source':'trendlyne','screener_id':'s2','screener_name':'Death Cross',
             'category':'technical_trend','subcategory':'trend_indicator',
             'signal_bias':'bearish','investment_horizon':'swing','confidence':'0.74'},
        ])
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        count = ranker.seed_screener_catalog()
        assert count == 2
        rows = conn.execute('SELECT * FROM screener_catalog').fetchall()
        assert len(rows) == 2
        assert rows[0]['signal_bias'] == 'bullish'
        os.unlink(csv_path)

    def test_seed_idempotent(self):
        from unified_ranker import UnifiedRanker
        conn = make_db()
        csv_path = make_csv([
            {'source':'trendlyne','screener_id':'s1','screener_name':'X',
             'category':'technical_trend','subcategory':'','signal_bias':'bullish',
             'investment_horizon':'swing','confidence':'0.74'},
        ])
        ranker = UnifiedRanker(conn=conn, csv_path=csv_path)
        ranker.seed_screener_catalog()
        ranker.seed_screener_catalog()  # second call must not fail
        count = conn.execute('SELECT COUNT(*) FROM screener_catalog').fetchone()[0]
        assert count == 1
        os.unlink(csv_path)


class TestScreenerStockScore:
    def test_fundamental_strong_scores_higher_than_weak(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'STRONG': [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*3,
            'WEAK':   [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*3,
        }
        fund_scores = {'STRONG': 80.0, 'WEAK': 30.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['STRONG'] > scores['WEAK']

    def test_bearish_screener_reduces_score(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'BULL_STOCK':  [{'signal_bias':'bullish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*5,
            'BEAR_STOCK':  [{'signal_bias':'bearish','confidence':0.74,'category':'technical_breakout','subcategory':'price_breakout','investment_horizon':'swing'}]*5,
        }
        fund_scores = {'BULL_STOCK': 50.0, 'BEAR_STOCK': 50.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['BULL_STOCK'] > scores['BEAR_STOCK']

    def test_risk_red_flags_heavily_penalises(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'CLEAN': [{'signal_bias':'bullish','confidence':0.74,'category':'fundamental_quality','subcategory':'capital_efficiency','investment_horizon':'long_term'}]*3,
            'RISKY': [
                {'signal_bias':'bullish','confidence':0.74,'category':'fundamental_quality','subcategory':'capital_efficiency','investment_horizon':'long_term'},
                {'signal_bias':'neutral','confidence':0.74,'category':'risk_red_flags','subcategory':'financial_or_governance_risk','investment_horizon':'long_term'},
            ],
        }
        fund_scores = {'CLEAN': 75.0, 'RISKY': 75.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['CLEAN'] > scores['RISKY']

    def test_fundamental_strong_in_few_screeners_beats_weak_in_many(self):
        from unified_ranker import compute_screener_stock_scores

        membership = {
            'FEW_STRONG': [
                {'signal_bias':'bullish','confidence':0.82,'category':'fundamental_quality','subcategory':'capital_efficiency','investment_horizon':'long_term'},
                {'signal_bias':'bullish','confidence':0.82,'category':'fundamental_growth','subcategory':'earnings_growth','investment_horizon':'long_term'},
            ]*3,
            'MANY_WEAK': [
                {'signal_bias':'bullish','confidence':0.74,'category':'technical_trend','subcategory':'trend_indicator','investment_horizon':'intraday'},
            ]*20,
        }
        fund_scores = {'FEW_STRONG': 80.0, 'MANY_WEAK': 30.0}
        scores, _, _ = compute_screener_stock_scores(membership, fund_scores)
        assert scores['FEW_STRONG'] > scores['MANY_WEAK']
