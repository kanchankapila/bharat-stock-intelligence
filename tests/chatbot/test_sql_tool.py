import sqlite3
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.sql_tool import (
    get_stock_fundamentals,
    filter_stocks_by_fundamentals,
    get_buy_signals,
    get_screener_membership,
    get_quant_scores,
)


@pytest.fixture
def test_db(tmp_path):
    db_path = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE nse_stocks (
            symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT
        );
        CREATE TABLE stock_fundamentals (
            symbol TEXT PRIMARY KEY,
            trailing_pe REAL, price_to_book REAL, return_on_equity REAL,
            revenue_growth REAL, earnings_growth REAL, debt_to_equity REAL,
            market_cap REAL, piotroski_f_score INTEGER, dividend_yield REAL
        );
        CREATE TABLE stock_scores (
            symbol TEXT, timeframe TEXT, score REAL, confidence REAL,
            classification TEXT, top_domain TEXT,
            PRIMARY KEY (symbol, timeframe)
        );
        CREATE TABLE stock_factor_breakdown (
            symbol TEXT, timeframe TEXT,
            technical REAL, fundamental REAL, momentum REAL, valuation REAL,
            PRIMARY KEY (symbol, timeframe)
        );
        CREATE TABLE signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT, type TEXT, entry REAL, target REAL, stopLoss REAL,
            confidence REAL, reasoning TEXT, status TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE screener_master (
            scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
            inferred_sentiment TEXT, inferred_category TEXT
        );
        CREATE TABLE trendlyne_screener_stocks (
            screener_id TEXT, symbol TEXT, PRIMARY KEY (screener_id, symbol)
        );
        CREATE TABLE moneycontrol_screener_stocks (
            scan_id TEXT, mcsymbol TEXT, symbol TEXT, stock_name TEXT,
            PRIMARY KEY (scan_id, mcsymbol)
        );
        CREATE TABLE quant_scores (
            symbol TEXT PRIMARY KEY,
            return_1w REAL, return_1m REAL, return_3m REAL, return_6m REAL,
            above_sma200 INTEGER, momentum_score REAL
        );
    """)
    conn.executemany("INSERT INTO nse_stocks VALUES (?,?,?,?)", [
        ("INFY", "Infosys Ltd", "IT", "Software"),
        ("HDFCBANK", "HDFC Bank", "Banking", "Private Bank"),
    ])
    conn.executemany("INSERT INTO stock_fundamentals VALUES (?,?,?,?,?,?,?,?,?,?)", [
        ("INFY", 22.5, 4.2, 35.0, 12.0, 15.0, 0.1, 750000000000, 8, 2.5),
        ("HDFCBANK", 18.0, 3.1, 16.5, 8.0, 10.0, 0.5, 1200000000000, 7, 1.2),
    ])
    conn.executemany("INSERT INTO stock_scores VALUES (?,?,?,?,?,?)", [
        ("INFY", "long_term", 82.0, 0.85, "Strong Buy", "Fundamental"),
        ("HDFCBANK", "long_term", 74.0, 0.78, "Buy", "Technical"),
    ])
    conn.executemany("INSERT INTO stock_factor_breakdown VALUES (?,?,?,?,?,?)", [
        ("INFY", "long_term", 75.0, 88.0, 70.0, 80.0),
        ("HDFCBANK", "long_term", 80.0, 72.0, 65.0, 68.0),
    ])
    conn.execute("INSERT INTO signals VALUES (?,?,?,?,?,?,?,?,?,?)",
                 (None, "INFY", "BUY", 1450.0, 1600.0, 1380.0, 0.88, "Strong momentum", "ACTIVE", "2026-06-15 10:00:00"))
    conn.execute("INSERT INTO screener_master VALUES (?,?,?,?,?)",
                 ("TL_001", "Low PE High ROE", "trendlyne", "bullish", "fundamental"))
    conn.execute("INSERT INTO trendlyne_screener_stocks VALUES (?,?)", ("TL_001", "INFY"))
    conn.executemany("INSERT INTO quant_scores VALUES (?,?,?,?,?,?,?)", [
        ("INFY", 2.1, 8.5, 18.0, 22.0, 1, 78.5),
        ("HDFCBANK", 1.5, 5.0, 12.0, 18.0, 1, 65.0),
    ])
    conn.commit()
    conn.close()
    return db_path


def test_get_stock_fundamentals_returns_full_profile(test_db):
    result = get_stock_fundamentals("INFY", db_path=test_db)
    assert result["symbol"] == "INFY"
    assert result["name"] == "Infosys Ltd"
    assert result["trailing_pe"] == 22.5
    assert result["return_on_equity"] == 35.0
    assert result["score"] == 82.0
    assert result["classification"] == "Strong Buy"
    assert result["technical_score"] == 75.0


def test_get_stock_fundamentals_unknown_symbol_returns_none(test_db):
    result = get_stock_fundamentals("UNKNOWN", db_path=test_db)
    assert result is None


def test_filter_stocks_by_fundamentals_pe_filter(test_db):
    results = filter_stocks_by_fundamentals(pe_lt=20.0, db_path=test_db)
    symbols = [r["symbol"] for r in results]
    assert "HDFCBANK" in symbols
    assert "INFY" not in symbols


def test_filter_stocks_by_fundamentals_roe_filter(test_db):
    results = filter_stocks_by_fundamentals(roe_gt=20.0, db_path=test_db)
    symbols = [r["symbol"] for r in results]
    assert "INFY" in symbols
    assert "HDFCBANK" not in symbols


def test_filter_stocks_combined_criteria(test_db):
    results = filter_stocks_by_fundamentals(pe_lt=25.0, roe_gt=10.0, min_score=70.0, db_path=test_db)
    assert len(results) >= 1
    for r in results:
        assert r["trailing_pe"] < 25.0
        assert r["return_on_equity"] > 10.0
        assert r["score"] >= 70.0


def test_get_buy_signals_all(test_db):
    results = get_buy_signals(db_path=test_db)
    assert len(results) == 1
    assert results[0]["symbol"] == "INFY"
    assert results[0]["type"] == "BUY"


def test_get_buy_signals_by_symbol(test_db):
    results = get_buy_signals(symbol="INFY", db_path=test_db)
    assert len(results) == 1
    results_other = get_buy_signals(symbol="HDFCBANK", db_path=test_db)
    assert len(results_other) == 0


def test_get_screener_membership(test_db):
    results = get_screener_membership("INFY", db_path=test_db)
    assert len(results) >= 1
    names = [r["screener_name"] for r in results]
    assert "Low PE High ROE" in names


def test_get_quant_scores_sorted_by_momentum(test_db):
    results = get_quant_scores(sort_by="momentum_score", limit=5, db_path=test_db)
    assert results[0]["symbol"] == "INFY"
    assert results[0]["momentum_score"] == 78.5
