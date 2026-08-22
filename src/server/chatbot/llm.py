import os
import time
import logging

logger = logging.getLogger(__name__)

# ponytail: Ollama removed 2026-08-20 (local model didn't fit this box's VRAM; see
# measurement.md/CLAUDE.md session notes). Gemini is now the only chatbot LLM backend.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

_cached_llm = None


def get_llm():
    """Return the Gemini chat model. Cached after first call."""
    global _cached_llm
    if _cached_llm is not None:
        return _cached_llm

    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set — the chatbot has no LLM backend configured.")

    from langchain_google_genai import ChatGoogleGenerativeAI
    _cached_llm = ChatGoogleGenerativeAI(model=GEMINI_MODEL, google_api_key=GEMINI_API_KEY)
    logger.info(f"Using Gemini model: {GEMINI_MODEL}")

    return _cached_llm


def reset_llm_cache():
    """Force re-detection of LLM on next call (useful in tests)."""
    global _cached_llm
    _cached_llm = None


def invoke_with_retry(llm, prompt: str, max_attempts: int = 3, base_delay: float = 1.0):
    """llm.invoke() with bounded exponential backoff. A transient Gemini hiccup previously
    propagated straight to a 500 (/chat) or an SSE error event (/chat/stream) with no retry
    — this bounds that to `max_attempts` tries before giving up."""
    last_err: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return llm.invoke(prompt)
        except Exception as e:
            last_err = e
            if attempt < max_attempts - 1:
                delay = base_delay * (2 ** attempt)
                logger.warning(f"LLM invoke failed (attempt {attempt + 1}/{max_attempts}), retrying in {delay:.1f}s: {e}")
                time.sleep(delay)
    logger.error(f"LLM invoke failed after {max_attempts} attempts: {last_err}")
    raise last_err
