"""
Unit test for market_intelligence_mcp tool dispatcher.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../mcp"))

from conftest import pg_available
import pytest
from market_intelligence_mcp import handle_mcp_request

pytestmark = pytest.mark.skipif(not pg_available(), reason="Postgres required")


def test_inspect_ingestion_health_returns_dict(pg_db_conn):
    res = handle_mcp_request("inspect_ingestion_health", {})
    assert "result" in res
    result = res["result"]
    assert "heartbeats" in result
    assert "dlq_new_counts" in result
    assert "data_quality_issues" in result


def test_analyze_stock_risk(pg_db_conn):
    res = handle_mcp_request("analyze_stock_risk", {"symbol": "RELIANCE"})
    assert "result" in res
    assert res["result"]["symbol"] == "RELIANCE"


def test_unknown_tool():
    res = handle_mcp_request("non_existent_tool", {})
    assert "error" in res
