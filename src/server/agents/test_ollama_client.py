"""
Pins get_narrative()'s request payload: keep_alive must not be 0.

Why this exists: keep_alive=0 forces Ollama to unload the model after every single call.
auditor_agent.py and strategist_agent.py both call get_narrative() once PER TIMEFRAME in a
loop, so a run paid a full model reload (~20.5s live-measured for mistral, 2026-08-15) on
every iteration for no reason -- and under real contention from this box's concurrent
GPU-heavy jobs, that reload cost can run far longer, compounding past agent-auditor's 15-min
outer timeout. Traced live: "Timed out...No stderr captured" is the signature of a hang
mid-load, not a Python exception (get_narrative's own try/except would have printed one).

Negative control (run 2026-08-15): restoring `"keep_alive": 0` makes
test_keep_alive_is_not_forced_to_zero fail (payload["keep_alive"] == 0).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import ollama_client


class _FakeResponse:
    def raise_for_status(self):
        pass

    def json(self):
        return {"response": "ok"}


def test_keep_alive_is_not_forced_to_zero(monkeypatch):
    captured = {}

    def fake_post(url, json, timeout):
        captured["json"] = json
        return _FakeResponse()

    monkeypatch.setattr(ollama_client.requests, "post", fake_post)
    ollama_client.get_narrative("test prompt")

    assert captured["json"].get("keep_alive") != 0, (
        "keep_alive=0 forces a full model unload+reload on every call -- omit it (Ollama "
        "default keep_alive=5m) so sequential per-timeframe calls in the same run reuse the "
        "warm model."
    )


def test_prompt_and_model_still_forwarded(monkeypatch):
    captured = {}

    def fake_post(url, json, timeout):
        captured["json"] = json
        return _FakeResponse()

    monkeypatch.setattr(ollama_client.requests, "post", fake_post)
    ollama_client.get_narrative("hello world")

    assert captured["json"]["prompt"] == "hello world"
    assert captured["json"]["model"] == ollama_client.OLLAMA_MODEL
    assert captured["json"]["stream"] is False


if __name__ == "__main__":
    class _Monkeypatch:
        def setattr(self, obj, name, value):
            setattr(obj, name, value)

    mp = _Monkeypatch()
    test_keep_alive_is_not_forced_to_zero(mp)
    test_prompt_and_model_still_forwarded(mp)
    print("OK")
