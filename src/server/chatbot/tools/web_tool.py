import warnings
with warnings.catch_warnings():
    warnings.simplefilter("ignore", RuntimeWarning)
    from duckduckgo_search import DDGS


def web_search(query: str, max_results: int = 5) -> list[dict]:
    """Search the web using DuckDuckGo. Returns list of {title, snippet, url}."""
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=max_results))
        return [
            {"title": r.get("title", ""), "snippet": r.get("body", ""), "url": r.get("href", "")}
            for r in raw
        ]
    except Exception:
        return []


def web_search_stock(
    symbol: str,
    company_name: str,
    topic: str,
    max_results: int = 5,
) -> list[dict]:
    """Targeted web search for a specific stock and topic."""
    query = f"{company_name} {symbol} NSE {topic}"
    return web_search(query, max_results=max_results)
