"""
Bharat Stock Intelligence — Worker Service & Engine Server (FastAPI).

Provides low-latency microservice endpoints for ML inference, MCP tool dispatch,
and ingestion health monitoring.
"""

import logging
import polars as pl
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn
import sys
import os

logger = logging.getLogger("worker_service")

sys.path.insert(0, os.path.dirname(__file__))
from mcp.market_intelligence_mcp import handle_mcp_request, analyze_stock_risk, get_top_conviction_picks
from db_compat import connect, query_one

app = FastAPI(
    title="Bharat Stock Intelligence Engine Worker",
    version="1.0.0",
    description="High-performance async engine for inference, scoring, and MCP tools",
)


class MCPRequest(BaseModel):
    tool_name: str
    arguments: Optional[Dict[str, Any]] = None


class RiskAnalysisRequest(BaseModel):
    symbol: str


@app.get("/health")
def health_check():
    """Health check probing PostgreSQL connection."""
    try:
        conn = connect()
        try:
            row = conn.execute("SELECT 1").fetchone()
            db_status = "ok" if row else "degraded"
        finally:
            conn.close()
    except Exception as exc:
        db_status = f"error: {exc}"

    return {
        "status": "online",
        "service": "engine_worker",
        "db": db_status,
    }


@app.post("/mcp/tools")
def dispatch_mcp_tool(req: MCPRequest):
    """Executes Model Context Protocol (MCP) tool requests."""
    res = handle_mcp_request(req.tool_name, req.arguments or {})
    if "error" in res:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


@app.post("/signals/risk-summary")
def get_risk_summary(req: RiskAnalysisRequest):
    """Returns risk indicators and scoring metrics for a target stock symbol."""
    return analyze_stock_risk(req.symbol)


@app.get("/ingestion/dlq")
def get_dlq_entries(limit: int = 20):
    """Returns recent entries from data_ingestion_dlq."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, fetcher_name, domain, payload_sample, error_message, created_at, status FROM data_ingestion_dlq ORDER BY created_at DESC LIMIT ?",
            [limit],
        ).fetchall()
        return {"entries": [dict(r) for r in rows]}
    finally:
        conn.close()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)


if __name__ == "__main__":
    # Without this block the module only DEFINES `app` and exits 0 immediately -- which
    # under ecosystem.config.cjs's `common` (autorestart, min_uptime 10s, max_restarts 10)
    # looks like a healthy launch, restarts ten times, then parks at `errored` with
    # nothing ever bound to the port. Mirrors python_api.py's entrypoint exactly.
    port = int(os.environ.get("ENGINE_WORKER_PORT", 8005))
    logger.info("Starting Engine Worker on port %d...", port)
    uvicorn.run("worker_service:app", host="127.0.0.1", port=port, reload=False)
