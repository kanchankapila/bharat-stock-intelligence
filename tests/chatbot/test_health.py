"""Readiness must not report success when chatbot dependencies are unavailable."""
import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def chatbot_app(monkeypatch):
    folder = Path(__file__).resolve().parents[2] / "src" / "server" / "chatbot"
    monkeypatch.syspath_prepend(str(folder))
    spec = importlib.util.spec_from_file_location("chatbot_health_under_test", folder / "app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("graph_ready,llm_ready", [(True, True), (True, False), (False, True), (False, False)])
def test_health_requires_graph_and_llm(chatbot_app, monkeypatch, graph_ready, llm_ready):
    import llm

    class FakeLLM:
        pass

    def get_llm():
        if not llm_ready:
            raise RuntimeError("credential unavailable")
        return FakeLLM()

    monkeypatch.setattr(llm, "get_llm", get_llm)
    monkeypatch.setattr(chatbot_app, "_graph", object() if graph_ready else None)
    # No context manager: do not run lifespan, ingest, or contact a provider.
    response = TestClient(chatbot_app.app).get("/health")
    ready = graph_ready and llm_ready
    assert response.status_code == (200 if ready else 503)
    assert response.json() == {
        "status": "ok" if ready else "degraded",
        "llm": "FakeLLM" if llm_ready else "unavailable",
        "graph_ready": graph_ready,
    }
