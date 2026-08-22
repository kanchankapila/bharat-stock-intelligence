import os
import requests

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", os.environ.get("OLLAMA_SIGNAL_MODEL", "mistral"))
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "120"))


def get_narrative(prompt: str) -> str:
    """Call local Ollama and return generated text. Returns fallback string on any error."""
    try:
        resp = requests.post(
            OLLAMA_URL,
            # keep_alive omitted (Ollama default: 5m), not 0. Every caller of this function
            # (auditor_agent.py, strategist_agent.py) calls it once PER TIMEFRAME in a loop --
            # keep_alive=0 forced a full model unload+reload between each of those calls in the
            # SAME run. Live-measured 2026-08-15: a cold mistral load costs ~20.5s
            # (load_duration dominates total_duration; eval itself is ~40ms), paid again on
            # every single loop iteration for no reason -- and under real contention from this
            # box's concurrent GPU-heavy jobs (e.g. a same-day dl_engine.py LSTM run sharing the
            # same 8GB VRAM), that reload cost can run far longer, compounding across timeframes
            # past agent-auditor's 15-min outer timeout ("Timed out...No stderr captured" is the
            # signature of exactly this: a hang mid-load, not a Python exception).
            json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
            timeout=OLLAMA_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()["response"].strip()
    except Exception as exc:
        print(f"[OLLAMA] Narrative unavailable: {exc}")
        return f"[Narrative unavailable: {exc}]"
