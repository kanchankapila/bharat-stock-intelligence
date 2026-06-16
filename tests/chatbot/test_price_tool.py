import pytest
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.price_tool import get_live_price, get_earnings_calendar


def _mock_ticker(price=1450.0, prev_close=1420.0, day_high=1470.0, day_low=1435.0,
                 week52_high=1800.0, week52_low=1100.0, volume=2500000):
    m = MagicMock()
    m.fast_info.last_price = price
    m.fast_info.previous_close = prev_close
    m.fast_info.day_high = day_high
    m.fast_info.day_low = day_low
    m.fast_info.fifty_two_week_high = week52_high
    m.fast_info.fifty_two_week_low = week52_low
    m.fast_info.last_volume = volume
    return m


def test_get_live_price_returns_expected_fields():
    with patch("tools.price_tool.yf.Ticker", return_value=_mock_ticker()):
        result = get_live_price("INFY")
    assert result["symbol"] == "INFY"
    assert result["price"] == 1450.0
    assert abs(result["change_pct"] - (1450.0 - 1420.0) / 1420.0 * 100) < 0.01
    assert result["day_high"] == 1470.0
    assert result["week52_high"] == 1800.0


def test_get_live_price_appends_ns_suffix():
    with patch("tools.price_tool.yf.Ticker") as mock_cls:
        mock_cls.return_value = _mock_ticker()
        get_live_price("INFY")
        mock_cls.assert_called_once_with("INFY.NS")


def test_get_live_price_returns_none_on_error():
    with patch("tools.price_tool.yf.Ticker", side_effect=Exception("network error")):
        result = get_live_price("INFY")
    assert result is None


def test_get_earnings_calendar_returns_dict_with_expected_keys(tmp_path):
    import sqlite3
    db_path = str(tmp_path / "test.db")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, industry TEXT);
        CREATE TABLE technical_analysis_signals (symbol TEXT PRIMARY KEY, trend TEXT, rsi REAL);
        CREATE TABLE stock_scores (symbol TEXT, timeframe TEXT, score REAL, classification TEXT,
            confidence REAL, top_domain TEXT, PRIMARY KEY (symbol, timeframe));
    """)
    conn.execute("INSERT INTO nse_stocks VALUES ('INFY','Infosys Ltd','IT','Software')")
    conn.execute("INSERT INTO technical_analysis_signals VALUES ('INFY','Bullish',62.0)")
    conn.execute("INSERT INTO stock_scores VALUES ('INFY','long_term',80.0,'Buy',0.82,'Technical')")
    conn.commit()
    conn.close()

    mock_web = [{"title": "Q1 results", "snippet": "Infosys to declare Q1 results July 17", "url": "http://example.com"}]
    with patch("tools.price_tool.web_search", return_value=mock_web):
        result = get_earnings_calendar(days_ahead=30, db_path=db_path)

    assert isinstance(result, dict)
    assert "web_results" in result
    assert "bullish_stocks" in result
    assert "note" in result
