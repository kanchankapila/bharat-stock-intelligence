"""
Pins get_narrative()'s error-degradation contract: on any failure it returns a placeholder
string, never raises. auditor_agent.py/strategist_agent.py/optimizer_agent.py/
data_scientist_agent.py all treat the narrative as best-effort prose over numbers they've
already computed -- a raised exception here would kill the whole agent run over cosmetic text.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import narrative_client


def test_missing_api_key_degrades_to_placeholder_string(monkeypatch):
    monkeypatch.setattr(narrative_client, "GEMINI_API_KEY", "")
    result = narrative_client.get_narrative("test prompt")
    assert result.startswith("[Narrative unavailable:")


def test_llm_error_degrades_to_placeholder_string(monkeypatch):
    monkeypatch.setattr(narrative_client, "GEMINI_API_KEY", "fake-key")

    class _Boom:
        def invoke(self, prompt):
            raise RuntimeError("network error")

    monkeypatch.setattr(narrative_client, "_get_llm", lambda: _Boom())
    result = narrative_client.get_narrative("test prompt")
    assert result.startswith("[Narrative unavailable:")


def test_successful_call_returns_stripped_content(monkeypatch):
    monkeypatch.setattr(narrative_client, "GEMINI_API_KEY", "fake-key")

    class _Response:
        content = "  hello world  "

    class _Fake:
        def invoke(self, prompt):
            return _Response()

    monkeypatch.setattr(narrative_client, "_get_llm", lambda: _Fake())
    assert narrative_client.get_narrative("test prompt") == "hello world"


if __name__ == "__main__":
    class _Monkeypatch:
        def setattr(self, obj, name, value):
            setattr(obj, name, value)

    mp = _Monkeypatch()
    test_missing_api_key_degrades_to_placeholder_string(mp)
    test_llm_error_degrades_to_placeholder_string(mp)
    test_successful_call_returns_stripped_content(mp)
    print("OK")
