"""
Unit tests for worker_service FastAPI endpoints.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
from worker_service import app
from conftest import pg_available

pytestmark = pytest.mark.skipif(not pg_available(), reason="Postgres required")

client = TestClient(app)


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "online"
    assert data["db"] == "ok"


def test_mcp_tools_endpoint():
    payload = {
        "tool_name": "inspect_ingestion_health",
        "arguments": {}
    }
    response = client.post("/mcp/tools", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "result" in data


def test_risk_summary_endpoint():
    response = client.post("/signals/risk-summary", json={"symbol": "TATAMOTORS"})
    assert response.status_code == 200
    data = response.json()
    assert data["symbol"] == "TATAMOTORS"


def test_dlq_endpoint():
    response = client.get("/ingestion/dlq?limit=5")
    assert response.status_code == 200
    data = response.json()
    assert "entries" in data
