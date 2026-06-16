import os
import logging

logger = logging.getLogger(__name__)

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Allow explicit override; if not set, auto-detect from Ollama
_OLLAMA_MODEL_OVERRIDE = os.getenv("OLLAMA_MODEL", "")

_PREFERRED_MODEL_KEYWORDS = ["llama3", "llama", "mistral", "gemma", "phi", "qwen"]

_cached_llm = None


def _pick_best_ollama_model(models: list[str]) -> str | None:
    """Pick the best available model by preference order."""
    if not models:
        return None
    for keyword in _PREFERRED_MODEL_KEYWORDS:
        for m in models:
            if keyword in m.lower():
                return m
    return models[0]  # fallback: first available


def get_llm():
    """Return Ollama if reachable with an available model, else Gemini. Cached after first call."""
    global _cached_llm
    if _cached_llm is not None:
        return _cached_llm

    try:
        import httpx
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3.0)
        resp.raise_for_status()

        # Pick model: env override takes priority, else auto-detect
        if _OLLAMA_MODEL_OVERRIDE:
            model_name = _OLLAMA_MODEL_OVERRIDE
        else:
            tags_data = resp.json()
            available = [m["name"] for m in tags_data.get("models", [])]
            model_name = _pick_best_ollama_model(available)
            if not model_name:
                raise ValueError("No Ollama models installed")

        from langchain_ollama import ChatOllama
        _cached_llm = ChatOllama(model=model_name, base_url=OLLAMA_BASE_URL)
        logger.info(f"Using Ollama model: {model_name}")

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
