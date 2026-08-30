"""
Unit tests for worker_service FastAPI endpoints.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
from worker_service import app

# NOT conftest.pg_available(): that checks reachability via PGTEST_* (pg_test_support._pg_dsn),
# but every endpoint here goes through db_compat.connect(), which reads POSTGRES_*/POSTGRES_URL
# instead -- a different env-var convention pointing at a different port. CI's python-tests job
# deliberately sets only PGTEST_* (db_compat.py: "so a stray production URL can never redirect a
# schema-creating run"), so POSTGRES_PORT is unset there and db_compat falls back to its hardcoded
# default of 5433 -- which isn't the job's Postgres service (mapped to 5432). pg_available() said
# "reachable" (true, on 5432) while every test here then failed with connection refused on 5433.
# Gate on the same connector the code under test actually uses, so this skips exactly when
# db_compat has nothing to connect to, regardless of which env-var convention supplied it.
def _db_compat_available() -> bool:
    try:
        from db_compat import connect
        connect().close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_compat_available(), reason="Postgres (via db_compat) required")

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
