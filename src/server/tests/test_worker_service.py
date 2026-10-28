"""
Unit tests for worker_service FastAPI endpoints.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
from worker_service import app

# Bind the real endpoint connector to a PGTEST-owned private schema. A collection-time
# reachability probe neither creates its tables nor prevents reading production.
pytestmark = pytest.mark.usefixtures('pg_db')

client = TestClient(app)


def test_endpoints_use_private_test_schema():
    from db_compat import connect
    conn = connect()
    try:
        row = conn.execute('SELECT current_schema() AS name').fetchone()
        assert row['name'].startswith('pytest_'), row
    finally:
        conn.close()


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "online"
    assert data["db"] == "ok"


def test_mcp_tools_endpoint(pg_db_conn):
    pg_db_conn.execute(
        'INSERT INTO job_heartbeat (job_name, last_status, last_error) VALUES (?, ?, ?)',
        ('ZZ_TEST_WORKER', 'failed', 'isolated-probe'),
    )
    pg_db_conn.commit()
    payload = {
        "tool_name": "inspect_ingestion_health",
        "arguments": {}
    }
    response = client.post("/mcp/tools", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "result" in data
    assert data['result']['heartbeats'][0]['job_name'] == 'ZZ_TEST_WORKER'
    assert data['result']['heartbeats'][0]['last_error'] == 'isolated-probe'


def test_decision_tools_endpoint_is_read_only():
    response = client.post(
        "/mcp/decision-tools",
        json={"tool_name": "get_ontology_context", "arguments": {"question": "market regime"}},
    )
    assert response.status_code == 200
    assert "result" in response.json()

    response = client.post(
        "/mcp/decision-tools",
        json={"tool_name": "run_fetcher", "arguments": {"fetcher_name": "nse_bhavcopy_fetcher"}},
    )
    assert response.status_code == 400
    assert "read-only" in response.json()["detail"]


def test_risk_summary_endpoint(pg_db_conn):
    pg_db_conn.execute(
        'INSERT INTO stock_scores (symbol, timeframe, score) VALUES (?, ?, ?)',
        ('TATAMOTORS', 'SWING', 42.5),
    )
    pg_db_conn.commit()
    response = client.post("/signals/risk-summary", json={"symbol": "TATAMOTORS"})
    assert response.status_code == 200
    data = response.json()
    assert data["symbol"] == "TATAMOTORS"
    assert data['stock_scores']['score'] == 42.5


def test_dlq_endpoint_is_retired():
    # AF-20261003-07: the table had no writer, so the endpoint could only ever answer "no entries".
    assert client.get("/ingestion/dlq?limit=5").status_code == 404
