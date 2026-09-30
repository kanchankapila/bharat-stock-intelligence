"""NDTV Profit Full Integration Fetcher."""
from __future__ import annotations

import logging
from typing import Optional, Dict
import pandas as pd

logger = logging.getLogger(__name__)
BASE_URL = "https://www.ndtvprofit.com/api/v2"


def _get_session():
    """Return a configured session with TLS impersonation."""
    try:
        from curl_cffi import requests as cf_requests
        return cf_requests.Session(impersonate="chrome"), "curl_cffi"
    except ImportError:
        import requests
        session = requests.Session()
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
        })
        return session, "requests"


def _num(v) -> Optional[float]:
    """Finite number or None -- the API sends the STRING "NaN" for undefined ratios."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def fetch_stock_summary(symbol: str) -> Optional[Dict]:
    """F&O summary (basis, rollover, OI, PCR) for one F&O-eligible symbol.

    `/api/v2/stock-summary?symbol=` is the JSON route (same one ndtv_fno_basis_fetcher.py uses);
    `/api/v2/stocks/<sym>/` is the HTML web page and never parses (AF-20260930-21).
    """
    session, _ = _get_session()
    url = f"{BASE_URL}/stock-summary?symbol={symbol.upper()}"
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            logger.warning(f"NDTV {symbol} summary: HTTP {resp.status_code}")
            return None
        data = (resp.json() or {}).get("data") or {}
    except Exception as e:
        logger.error(f"NDTV {symbol} summary fetch failed: {e}")
        return None
    if not data:
        return None
    return {
        "symbol": symbol.upper(),
        "spot_price": _num(data.get("spot-price")),
        "future_1m": _num(data.get("1m-future")),
        "future_2m": _num(data.get("2m-future")),
        "basis_points": _num(data.get("basis")),
        "roll_spread": _num(data.get("roll-spread")),
        "rollover_pct": _num(data.get("roll-over-percentage")),
        "open_interest": _num(data.get("open-interest")),
        "oi_change_pct": _num(data.get("open-interest-change-percentage")),
        "pcr_oi": _num(data.get("put-call-ratio")),
    }


def fetch_open_interest(symbol: str, duration: str = "1m") -> Optional[pd.DataFrame]:
    """Per-strike call/put OI snapshot for one expiry.

    `duration` is the EXPIRY month (`1m`, `2m`), not a day window -- `15d` returns an empty list
    (AF-20260930-21). Each API row is ONE side of one strike; they are pivoted so a strike is one
    row, and a side the API did not send stays None (never 0).
    """
    session, _ = _get_session()
    url = f"{BASE_URL}/open-interest/?duration={duration}&stock={symbol.upper()}"
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            logger.warning(f"NDTV {symbol} OI: HTTP {resp.status_code}")
            return None
        items = (resp.json() or {}).get("data") or []
    except Exception as e:
        logger.error(f"NDTV {symbol} OI fetch failed: {e}")
        return None

    by_strike: dict = {}
    for item in items:
        side = {"call": "call", "put": "put"}.get(item.get("type"))
        strike = _num(item.get("strike-price"))
        if side is None or strike is None:
            continue
        rec = by_strike.setdefault((item.get("expiry-date"), strike), {
            "symbol": symbol.upper(),
            "expiry_date": pd.to_datetime(item.get("expiry-date")),
            "strike": strike,
            "call_oi": None, "put_oi": None,
            "call_oi_change": None, "put_oi_change": None,
            "call_oi_change_pct": None, "put_oi_change_pct": None,
        })
        rec[f"{side}_oi"] = _num(item.get("open-interest"))
        rec[f"{side}_oi_change"] = _num(item.get("open-interest-change"))
        rec[f"{side}_oi_change_pct"] = _num(item.get("open-interest-change-percentage"))

    if not by_strike:
        return None
    df = pd.DataFrame(list(by_strike.values())).astype(object)
    return df.sort_values(["expiry_date", "strike"]).reset_index(drop=True)


def fetch_corporate_announcements(symbol: str) -> Optional[pd.DataFrame]:
    """Fetch corporate announcements for a symbol."""
    session, _ = _get_session()
    url = f"{BASE_URL}/stocks/announcements/?exchangeSymbol={symbol}"
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception as e:
        logger.error(f"NDTV {symbol} announcements failed: {e}")
        return None

    records = []
    items = data if isinstance(data, list) else data.get("data", data.get("results", []))
    for item in items:
        try:
            records.append({
                "symbol": symbol.upper(),
                "announcement_date": pd.to_datetime(item.get("date") or item.get("announcement_date")),
                "title": item.get("title", item.get("headline", "")),
                "type": item.get("type", item.get("category", "")),
                "link": item.get("link", item.get("url", "")),
            })
        except Exception:
            continue

    if not records:
        return None
    return pd.DataFrame(records).sort_values("announcement_date").reset_index(drop=True)


def fetch_market_news(symbol: str) -> Optional[pd.DataFrame]:
    """Fetch market news specific to a symbol."""
    session, _ = _get_session()
    url = f"{BASE_URL}/market-news/?company={symbol}"
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            return None
        data = resp.json()
    except Exception as e:
        logger.error(f"NDTV {symbol} news failed: {e}")
        return None

    records = []
    items = data if isinstance(data, list) else data.get("data", data.get("results", []))
    for item in items:
        try:
            records.append({
                "symbol": symbol.upper(),
                "published_at": pd.to_datetime(item.get("pub_date") or item.get("published_at")),
                "title": item.get("title", item.get("headline", "")),
                "summary": item.get("summary", item.get("description", "")),
                "sentiment": item.get("sentiment", "neutral"),
                "url": item.get("url", item.get("link", "")),
            })
        except Exception:
            continue

    if not records:
        return None
    return pd.DataFrame(records).sort_values("published_at", ascending=False).reset_index(drop=True)

