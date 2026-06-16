import pytest
from unittest.mock import patch, MagicMock
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'server', 'chatbot'))

from tools.web_tool import web_search, web_search_stock

FAKE_RESULTS = [
    {"title": "Infosys Q4 results beat estimates", "body": "Infosys reported 15% revenue growth", "href": "http://example.com/1"},
    {"title": "Analyst upgrades Infosys", "body": "Price target raised to 1800", "href": "http://example.com/2"},
]


def test_web_search_returns_list_of_dicts():
    with patch("tools.web_tool.DDGS") as mock_ddgs_cls:
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = lambda s: s
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx.text.return_value = iter(FAKE_RESULTS)
        mock_ddgs_cls.return_value = mock_ctx

        results = web_search("Infosys results")

    assert isinstance(results, list)
    assert len(results) == 2
    assert results[0]["title"] == "Infosys Q4 results beat estimates"
    assert results[0]["snippet"] == "Infosys reported 15% revenue growth"
    assert results[0]["url"] == "http://example.com/1"


def test_web_search_respects_max_results():
    with patch("tools.web_tool.DDGS") as mock_ddgs_cls:
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = lambda s: s
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_ctx.text.return_value = iter(FAKE_RESULTS)
        mock_ddgs_cls.return_value = mock_ctx

        web_search("query", max_results=3)
        mock_ctx.text.assert_called_once_with("query", max_results=3)


def test_web_search_returns_empty_on_exception():
    with patch("tools.web_tool.DDGS", side_effect=Exception("network error")):
        results = web_search("query")
    assert results == []


def test_web_search_stock_constructs_targeted_query():
    with patch("tools.web_tool.web_search") as mock_ws:
        mock_ws.return_value = []
        web_search_stock("INFY", "Infosys Ltd", "analyst rating 2026")
        call_args = mock_ws.call_args[0][0]
        assert "INFY" in call_args
        assert "Infosys Ltd" in call_args
        assert "analyst rating 2026" in call_args
        assert "NSE" in call_args
