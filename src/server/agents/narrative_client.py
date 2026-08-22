import os

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

_cached_llm = None


def _get_llm():
    global _cached_llm
    if _cached_llm is None:
        from langchain_google_genai import ChatGoogleGenerativeAI
        _cached_llm = ChatGoogleGenerativeAI(model=GEMINI_MODEL, google_api_key=GEMINI_API_KEY)
    return _cached_llm


def get_narrative(prompt: str) -> str:
    """Call Gemini and return generated text. Returns a fallback string on any error (no
    GEMINI_API_KEY, network failure, etc.) -- callers (auditor_agent.py, strategist_agent.py,
    optimizer_agent.py, data_scientist_agent.py) treat the narrative as best-effort prose over
    numbers they've already computed, not something to crash the run over."""
    try:
        if not GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY is not set")
        resp = _get_llm().invoke(prompt)
        return str(getattr(resp, "content", resp)).strip()
    except Exception as exc:
        print(f"[NARRATIVE] Narrative unavailable: {exc}")
        return f"[Narrative unavailable: {exc}]"
