"""
Unit test for market_intelligence_mcp tool dispatcher.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../mcp"))

from conftest import pg_available
import pytest
from market_intelligence_mcp import handle_mcp_request, handle_read_only_mcp_request

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


def test_top_conviction_uses_current_recommendation_columns(pg_db_conn):
    res = handle_mcp_request("get_top_conviction_picks", {"limit": 1})
    assert "result" in res
    assert isinstance(res["result"], list)


def test_entity_graph_is_available_on_the_decision_surface(monkeypatch):
    import market_intelligence_mcp as mcp
    monkeypatch.setattr(mcp, "get_entity_graph", lambda symbol, limit=100, as_of=None: {
        "status": "ok", "symbol": symbol, "limit": limit, "as_of": as_of
    })
    res = handle_read_only_mcp_request("get_entity_graph", {"symbol": "RELIANCE", "limit": 5})
    assert res["result"]["status"] == "ok"
    assert res["result"]["limit"] == 5


def test_ontology_context_is_available_to_decision_agents():
    res = handle_mcp_request("get_ontology_context", {"question": "delivery percentage", "max_chars": 900})
    assert "result" in res
    assert "Guardrails" in res["result"]["pack"]


def test_decision_surface_rejects_operational_tools():
    res = handle_read_only_mcp_request("run_fetcher", {"fetcher_name": "nse_bhavcopy_fetcher"})
    assert "error" in res
    assert "read-only" in res["error"]


def test_unknown_tool():
    res = handle_mcp_request("non_existent_tool", {})
    assert "error" in res


def test_stdio_server_read_only_mode_gates_both_list_and_call():
    """AF-20260927-02: the stdio launcher's `--read-only` flag must restrict discovery
    (tools/list) AND dispatch (tools/call), not just the underlying handle_* function — a client
    that never sees an operational tool listed can't be tricked into calling it either. Negative
    control: reverting `_dispatch_rpc`'s `read_only` param (so it always calls handle_mcp_request
    and never filters tools/list) makes both assertions below fail — `run_fetcher` reappears in
    the list and executes instead of erroring."""
    import market_intelligence_mcp as mcp

    listed = mcp._dispatch_rpc("tools/list", {}, read_only=True)
    listed_names = {t["name"] for t in listed["tools"]}
    assert listed_names == mcp.DECISION_READ_ONLY_TOOLS
    assert "run_fetcher" not in listed_names

    called = mcp._dispatch_rpc(
        "tools/call", {"name": "run_fetcher", "arguments": {"fetcher_name": "nse_bhavcopy_fetcher"}},
        read_only=True,
    )
    assert called["isError"] is True
    assert "read-only" in called["content"][0]["text"]
