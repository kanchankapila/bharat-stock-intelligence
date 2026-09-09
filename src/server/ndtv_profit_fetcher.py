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


def fetch_stock_summary(symbol: str) -> Optional[Dict]:
    """Fetch stock summary including PCR, IV, OI data."""
    session, _ = _get_session()
    url = f"{BASE_URL}/stocks/{symbol.lower()}/"
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            logger.warning(f"NDTV {symbol} summary: HTTP {resp.status_code}")
            return None
        data = resp.json()
    except Exception as e:
        logger.error(f"NDTV {symbol} summary fetch failed: {e}")
        return None
    return {
        "symbol": symbol.upper(),
        "pcr_oi": data.get("pcr", data.get("pcr_oi")),
        "pcr_vol": data.get("pcr_volume"),
        "iv": data.get("iv", data.get("implied_volatility")),
        "max_pain": data.get("max_pain"),
        "max_pain_strike": data.get("max_pain_strike"),
        "basis_points": data.get("basis", data.get("basis_points")),
        "cost_of_carry": data.get("cost_of_carry_ann"),
        "call_oi": data.get("call_oi"),
        "put_oi": data.get("put_oi"),
        "iv_skew": data.get("iv_skew"),
    }


def fetch_open_interest(symbol: str, duration: str = "15d") -> Optional[pd.DataFrame]:
    """Fetch open interest history for a symbol."""
    session, _ = _get_session()
    url = f"{BASE_URL}/open-interest/?duration={duration}&stock={symbol}"
    try:
        resp = session.get(url, timeout=30)
        if resp.status_code != 200:
            logger.warning(f"NDTV {symbol} OI: HTTP {resp.status_code}")
            return None
        data = resp.json()
    except Exception as e:
        logger.error(f"NDTV {symbol} OI fetch failed: {e}")
        return None

    records = []
    items = data if isinstance(data, list) else data.get("data", data.get("results", []))
    for item in items:
        try:
            call_oi = item.get("call_oi", item.get("ce_oi", 0)) or 0
            put_oi = item.get("put_oi", item.get("pe_oi", 0)) or 0
            records.append({
                "symbol": symbol.upper(),
                "date": pd.to_datetime(item.get("date") or item.get("expiry")),
                "call_oi": call_oi,
                "put_oi": put_oi,
                "pcr": put_oi / call_oi if call_oi else 0,
                "max_pain": item.get("max_pain"),
                "iv": item.get("iv", item.get("implied_volatility")),
            })
        except (ValueError, TypeError):
            continue

    if not records:
        return None
    return pd.DataFrame(records).sort_values("date").reset_index(drop=True)


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

