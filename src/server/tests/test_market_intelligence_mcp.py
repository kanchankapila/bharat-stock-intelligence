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
    # AF-20261003-07: data_ingestion_dlq had readers and no writer, so this always reported "no dead
    # letters". Failures live per step in job_run_history; the empty report is gone, not zero.
    assert "dlq_new_counts" not in result
    assert "data_quality_issues" in result


def test_analyze_stock_risk(pg_db_conn):
    res = handle_mcp_request("analyze_stock_risk", {"symbol": "RELIANCE"})
    assert "result" in res
    assert res["result"]["symbol"] == "RELIANCE"


def test_risk_profile_identifies_probability_fields_as_unvalidated(pg_db_conn):
    pg_db_conn.execute(
        "INSERT INTO technical_signals (symbol, date, win_probability, calibrated_win_probability) "
        "VALUES ('RELIANCE', '2026-10-28', 0.8, 0.7)"
    )
    pg_db_conn.commit()
    risk = handle_mcp_request("analyze_stock_risk", {"symbol": "RELIANCE"})["result"]
    assert risk["technical_signals"]["win_probability"] == pytest.approx(0.8)
    assert "not validated" in risk["probability_note"].lower()


def test_top_conviction_uses_current_recommendation_columns(pg_db_conn):
    res = handle_mcp_request("get_top_conviction_picks", {"limit": 1})
    assert "result" in res
    assert isinstance(res["result"], list)


def test_top_conviction_reads_only_latest_batch_and_never_falls_back(pg_db_conn):
    pg_db_conn.execute(
        "INSERT INTO unified_recommendations "
        "(symbol, computed_at, regime, unified_score, conviction_level, classification) VALUES "
        "('OLD', '2026-10-01', 'BULL', 99, 'S_ELITE', 'Strong Buy'), "
        "('NEW', '2026-10-02', 'BULL', 75, 'A_HIGH', 'Buy'), "
        "('SELL', '2026-10-02', 'BULL', 95, 'S_ELITE', 'Strong Sell')"
    )
    pg_db_conn.commit()
    picks = handle_mcp_request("get_top_conviction_picks", {"limit": 10})["result"]
    assert [p["symbol"] for p in picks] == ["NEW"]
    assert picks[0]["computed_at"] == "2026-10-02"

    # A latest batch containing no buys must not revive an older recommendation.
    pg_db_conn.execute(
        "INSERT INTO unified_recommendations "
        "(symbol, computed_at, regime, unified_score, conviction_level, classification) "
        "VALUES ('HOLD', '2026-10-03', 'BULL', 50, 'C', 'Hold')"
    )
    pg_db_conn.commit()
    assert handle_mcp_request("get_top_conviction_picks", {"limit": 10})["result"] == []


def test_top_conviction_discloses_trade_plan_expiry(pg_db_conn):
    pg_db_conn.execute(
        "INSERT INTO unified_recommendations "
        "(symbol, computed_at, regime, unified_score, conviction_level, classification, valid_until) VALUES "
        "('EXPIRED', '2026-10-02', 'BULL', 90, 'S_ELITE', 'Strong Buy', '2000-01-01T00:00:00Z'), "
        "('ACTIVE', '2026-10-02', 'BULL', 80, 'A_HIGH', 'Buy', '2100-01-01T00:00:00Z'), "
        "('UNKNOWN', '2026-10-02', 'BULL', 70, 'A_HIGH', 'Buy', NULL)"
    )
    pg_db_conn.commit()
    picks = handle_mcp_request("get_top_conviction_picks", {"limit": 10})["result"]
    assert {p["symbol"]: p["plan_status"] for p in picks} == {
        "EXPIRED": "EXPIRED", "ACTIVE": "ACTIVE", "UNKNOWN": "UNKNOWN"
    }
    assert picks[0]["valid_until"] is not None


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
