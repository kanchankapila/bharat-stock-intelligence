"""
Bharat Stock Intelligence — Model Context Protocol (MCP) Server.

Exposes structured market intelligence, stock scoring, and pipeline health tools
for AI co-pilots and agents without giving raw unstructured SQL execution rights.
"""

import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from db_compat import connect, query_all, query_one


def get_top_conviction_picks(limit: int = 10, min_score: float = 60.0) -> List[Dict[str, Any]]:
    """Returns top conviction stock recommendations from unified_recommendations."""
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT symbol, unified_score, recommendation_action, conviction_level, target_price, stop_loss, generated_at
            FROM unified_recommendations
            WHERE unified_score >= ? AND recommendation_action LIKE 'BUY%'
            ORDER BY unified_score DESC
            LIMIT ?
            """,
            [min_score, limit],
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def analyze_stock_risk(symbol: str) -> Dict[str, Any]:
    """Retrieves risk score breakdown, volatility metrics, and score details for a given symbol."""
    conn = connect()
    try:
        score_row = conn.execute(
            "SELECT * FROM stock_scores WHERE symbol = ?", [symbol]
        ).fetchone()
        tech_row = conn.execute(
            "SELECT symbol, date, volume_ratio, win_probability, calibrated_win_probability, call_wall_dist_pct, put_wall_dist_pct FROM technical_signals WHERE symbol = ? ORDER BY date DESC LIMIT 1",
            [symbol],
        ).fetchone()

        return {
            "symbol": symbol,
            "stock_scores": dict(score_row) if score_row else None,
            "technical_signals": dict(tech_row) if tech_row else None,
        }
    finally:
        conn.close()


def inspect_ingestion_health() -> Dict[str, Any]:
    """Queries pipeline health, recent data quality checks, job heartbeats, and DLQ errors."""
    conn = connect()
    try:
        # NULLS LAST is load-bearing: Postgres sorts NULLs FIRST on a DESC order, so the
        # bare form returned 15 never-run jobs (last_run_at IS NULL) and hid every job that
        # had actually run -- the opposite of what this tool exists to report.
        heartbeats = conn.execute(
            "SELECT job_name, last_status, last_success_at, last_error FROM job_heartbeat "
            "ORDER BY last_run_at DESC NULLS LAST LIMIT 15"
        ).fetchall()
        dlq_summary = conn.execute(
            "SELECT fetcher_name, COUNT(*) as count FROM data_ingestion_dlq WHERE status = 'NEW' GROUP BY fetcher_name"
        ).fetchall()
        dq_fails = conn.execute(
            "SELECT check_id, status, detail, checked_at FROM data_quality_history WHERE status != 'PASS' ORDER BY checked_at DESC LIMIT 10"
        ).fetchall()

        return {
            "heartbeats": [dict(r) for r in heartbeats],
            "dlq_new_counts": [dict(r) for r in dlq_summary],
            "data_quality_issues": [dict(r) for r in dq_fails],
        }
    finally:
        conn.close()


def handle_mcp_request(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatches tool execution requests from LLM agents."""
    if tool_name == "get_top_conviction_picks":
        limit = arguments.get("limit", 10)
        min_score = arguments.get("min_score", 60.0)
        return {"result": get_top_conviction_picks(limit, min_score)}
    elif tool_name == "analyze_stock_risk":
        symbol = arguments.get("symbol", "")
        return {"result": analyze_stock_risk(symbol)}
    elif tool_name == "inspect_ingestion_health":
        return {"result": inspect_ingestion_health()}
    else:
        return {"error": f"Unknown tool: {tool_name}"}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        tool = sys.argv[1]
        args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        print(json.dumps(handle_mcp_request(tool, args), indent=2, default=str))

