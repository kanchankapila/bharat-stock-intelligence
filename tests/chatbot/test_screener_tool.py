import pytest
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))
sys.path.insert(0, os.path.dirname(__file__))  # package dir; makes the sibling conftest importable

from _pg_support import pg_available, patch_tool_connect
from tools import screener_tool
from tools.screener_tool import search_screener, get_screener_stocks

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")

_DDL = """
    CREATE TABLE screener_master (
        scan_id TEXT PRIMARY KEY, name TEXT, source TEXT,
        inferred_sentiment TEXT, inferred_category TEXT
    );
    CREATE TABLE trendlyne_screener_stocks (
        screener_id TEXT, symbol TEXT, PRIMARY KEY(screener_id, symbol)
    );
    CREATE TABLE moneycontrol_screener_stocks (
        scan_id TEXT, mcsymbol TEXT, symbol TEXT, stock_name TEXT,
        PRIMARY KEY(scan_id, mcsymbol)
    );
    CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT);
    CREATE TABLE stock_scores (
        symbol TEXT, timeframe TEXT, score REAL, classification TEXT,
        confidence REAL, top_domain TEXT, PRIMARY KEY(symbol, timeframe)
    );
"""


@pytest.fixture
def screener_db(pg_conn, monkeypatch):
    conn = pg_conn
    # One statement per execute(): SQLAlchemy rejects a multi-statement string.
    for stmt in filter(str.strip, _DDL.split(";")):
        conn.execute(stmt)
    conn.execute("INSERT INTO screener_master VALUES ('TL_001','Low PE High ROE','trendlyne','bullish','fundamental')")
    conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('TL_001','INFY')")
    conn.execute("INSERT INTO trendlyne_screener_stocks VALUES ('TL_001','TCS')")
    conn.execute("INSERT INTO nse_stocks VALUES ('INFY','Infosys','IT','Software')")
    conn.execute("INSERT INTO nse_stocks VALUES ('TCS','TCS','IT','Software')")
    conn.execute("INSERT INTO stock_scores VALUES ('INFY','long_term',82.0,'Strong Buy',0.85,'Fundamental')")
    conn.execute("INSERT INTO stock_scores VALUES ('TCS','long_term',78.0,'Buy',0.80,'Technical')")
    conn.commit()
    return patch_tool_connect(monkeypatch, screener_tool, conn)


def test_get_screener_stocks_by_id(screener_db):
    results = get_screener_stocks("TL_001", db_path=screener_db)
    symbols = [r["symbol"] for r in results]
    assert "INFY" in symbols
    assert "TCS" in symbols


def test_get_screener_stocks_enriched_with_scores(screener_db):
    results = get_screener_stocks("TL_001", db_path=screener_db)
    infy = next(r for r in results if r["symbol"] == "INFY")
    assert infy["score"] == 82.0
    assert infy["classification"] == "Strong Buy"


def test_search_screener_uses_chroma(screener_db):
    mock_collection = MagicMock()
    mock_collection.count.return_value = 1
    mock_collection.query.return_value = {
        "ids": [["screener_TL_001"]],
        "documents": [["Low PE High ROE. Source: trendlyne."]],
        "metadatas": [[{"scan_id": "TL_001", "name": "Low PE High ROE", "source": "trendlyne", "type": "screener"}]],
        "distances": [[0.12]],
    }
    mock_client = MagicMock()
    mock_client.get_or_create_collection.return_value = mock_collection

    with patch("tools.screener_tool.get_chroma_client", return_value=mock_client):
        with patch("tools.screener_tool.get_embedding_fn", return_value=MagicMock()):
            results = search_screener("low valuation high return stocks", db_path=screener_db)

    assert len(results) >= 1
    assert results[0]["screener_name"] == "Low PE High ROE"
    assert len(results[0]["stocks"]) >= 1
