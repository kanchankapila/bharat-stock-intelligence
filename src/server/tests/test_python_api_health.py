from fastapi.testclient import TestClient

import python_api


def test_ml_api_exposes_the_standard_health_route():
    response = TestClient(python_api.app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ml-api"}
