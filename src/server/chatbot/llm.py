import os
import logging

logger = logging.getLogger(__name__)

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

_cached_llm = None


def get_llm():
    """Return Ollama if reachable, else Gemini. Cached after first call."""
    global _cached_llm
    if _cached_llm is not None:
        return _cached_llm

    try:
        import httpx
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3.0)
        resp.raise_for_status()
        from langchain_ollama import ChatOllama
        _cached_llm = ChatOllama(model=OLLAMA_MODEL, base_url=OLLAMA_BASE_URL)
        logger.info(f"Using Ollama ({OLLAMA_MODEL})")
    except Exception as e:
        logger.warning(f"Ollama unavailable ({e}), falling back to Gemini")
        from langchain_google_genai import ChatGoogleGenerativeAI
        _cached_llm = ChatGoogleGenerativeAI(
            model="gemini-2.0-flash",
            google_api_key=GEMINI_API_KEY,
        )
        logger.info("Using Gemini fallback")

    return _cached_llm


def reset_llm_cache():
    """Force re-detection of LLM on next call (useful in tests)."""
    global _cached_llm
    _cached_llm = None
