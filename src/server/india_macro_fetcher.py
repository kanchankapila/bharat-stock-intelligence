#!/usr/bin/env python3
"""
Fetch India-specific macro indicators and persist to macro_asset_prices.

Indicators covered:
  INDIA_MFG_PMI         — S&P Global Manufacturing PMI (from MC eco-calendar actuals)
  INDIA_SERVICES_PMI    — S&P Global Services PMI
  INDIA_GST_YOY_PCT     — GST collections YoY growth %
  RBI_REPO_RATE         — RBI repo rate (from MC interest-rates feed)
  INDIA_10Y_MINUS_REPO  — 10-year G-sec yield spread over repo (yield curve proxy)
  INDIA_IIP_YOY         — Index of Industrial Production YoY %
  INDIA_AUTO_SALES_YOY  — Passenger vehicle sales YoY %
  INDIA_2W_SALES_YOY    — Two-wheeler sales YoY %

Signal thresholds (for downstream regime detection):
  PMI > 55  → strong expansion → cyclicals/industrials positive
  PMI 50-55 → moderate expansion
  PMI < 50  → contraction → rotate to defensives
  GST YoY > 15%   → strong economic activity
  RBI rate rising  → BFSI NIM expansion (short-term), growth headwind
  RBI rate cutting → rate-sensitive sectors positive (BFSI, real-estate, autos)

Usage:
  python india_macro_fetcher.py           # default last 60 days of eco-calendar actuals
  python india_macro_fetcher.py --days 90
"""

import argparse
import re
import sys
from datetime import datetime, timedelta

from curl_cffi import requests as cffi_req

from db_compat import connect, executemany, query_all

# ─── MC API config ─────────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin":     "https://www.moneycontrol.com",
    "Referer":    "https://www.moneycontrol.com/",
    "Accept":     "application/json",
}

# Actual (historical) events — paginated
_ACTUAL_URL = (
    "https://api.moneycontrol.com/mcapi/v1/ecalendar/get-actual-event-data"
    "?page={page}&pageSize=50"
)

# MC interest-rates premarket feed (already used by global_macro_fetcher for bonds)
_IR_URL = "https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=ir"

# ─── Event-name → asset_name mapping ─────────────────────────────────────────
# Keys are lowercased substrings; first match wins for each event.

_PMI_MFG_PATTERNS  = ["manufacturing pmi", "mfg pmi", "markit manufacturing", "s&p global manufacturing"]
_PMI_SVC_PATTERNS  = ["services pmi", "service pmi", "composite pmi", "markit services"]
_GST_PATTERNS      = ["gst revenue", "gst collection", "goods and services tax"]
_IIP_PATTERNS      = ["industrial production", "iip "]
_AUTO_CAR_PATTERNS = ["passenger vehicle", "passenger car", "pv sales", "car sales"]
_AUTO_2W_PATTERNS  = ["two wheeler", "two-wheeler", "2-wheeler", "2w sales", "motorcycle"]


def _classify_event(event_name: str) -> str | None:
    """Return asset_name for a recognized event or None to skip."""
    name_lc = event_name.lower()
    for pat in _PMI_MFG_PATTERNS:
        if pat in name_lc:
            return "INDIA_MFG_PMI"
    for pat in _PMI_SVC_PATTERNS:
        if pat in name_lc:
            return "INDIA_SERVICES_PMI"
    for pat in _GST_PATTERNS:
        if pat in name_lc:
            return "INDIA_GST_YOY_PCT"
    for pat in _IIP_PATTERNS:
        if pat in name_lc:
            return "INDIA_IIP_YOY"
    for pat in _AUTO_CAR_PATTERNS:
        if pat in name_lc:
            return "INDIA_AUTO_SALES_YOY"
    for pat in _AUTO_2W_PATTERNS:
        if pat in name_lc:
            return "INDIA_2W_SALES_YOY"
    return None


def _parse_event_date(date_str: str) -> str | None:
    """'Friday, Jun 26, 2026' or 'Friday, June 26, 2026' → 'YYYY-MM-DD'."""
    for fmt in ("%A, %b %d, %Y", "%A, %B %d, %Y"):
        try:
            return datetime.strptime(date_str.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Try plain ISO
    try:
        datetime.strptime(date_str.strip(), "%Y-%m-%d")
        return date_str.strip()
    except ValueError:
        return None


def _parse_numeric(raw: str | None) -> float | None:
    """Extract the first float from strings like '58.4', '8.4%', '1,58,000 Cr', etc."""
    if not raw:
        return None
    # Strip commas and extract leading number (possibly with % or units after)
    cleaned = raw.replace(",", "").strip()
    m = re.search(r"[-+]?\d+(?:\.\d+)?", cleaned)
    if m:
        return float(m.group())
    return None


# ─── Fetch actual events from MC eco-calendar ──────────────────────────────────

def _fetch_actual_events(days: int) -> list[dict]:
    """
    Pull MC eco-calendar actual events for the past `days` days.
    Returns a flat list of raw event dicts from the API.
    """
    cutoff = (datetime.today() - timedelta(days=days)).date()
    events: list[dict] = []

    for page in range(1, 20):  # hard cap at 1000 events
        url = _ACTUAL_URL.format(page=page)
        try:
            resp = cffi_req.get(url, headers=HEADERS, impersonate="chrome110", timeout=15)
            resp.raise_for_status()
            payload = resp.json()
        except Exception as exc:
            print(f"[IndiaMacro] WARN page {page} fetch error: {exc}")
            break

        if not payload.get("success"):
            # API may return success=0 on empty pages — just stop
            break

        page_events: list[dict] = []
        for day_block in payload.get("data", []):
            for ev in day_block.get("eventList", []):
                page_events.append(ev)

        if not page_events:
            break

        # Check if we've gone past the cutoff window
        oldest_on_page: str | None = None
        for ev in page_events:
            iso = _parse_event_date(ev.get("date", ""))
            if iso and (oldest_on_page is None or iso < oldest_on_page):
                oldest_on_page = iso

        events.extend(page_events)

        if oldest_on_page and oldest_on_page < cutoff.isoformat():
            break  # All remaining pages are older than our window

    return events


# ─── Persist indicators from eco-calendar actuals ─────────────────────────────

def _upsert_rows(rows: list[tuple]) -> None:
    """Upsert (date, symbol, close, ret_1d, ret_5d, fetched_at) into macro_asset_prices."""
    executemany(
        """INSERT INTO macro_asset_prices
               (date, symbol, close, ret_1d, ret_5d, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(date, symbol) DO UPDATE SET
             close=excluded.close,
             fetched_at=excluded.fetched_at""",
        rows,
    )


def process_eco_calendar_actuals(days: int) -> dict[str, float]:
    """
    Fetch MC eco-calendar actuals and write India macro indicators to macro_asset_prices.
    Returns {asset_name: latest_value} for display.
    """
    events = _fetch_actual_events(days)
    cutoff = (datetime.today() - timedelta(days=days)).date()
    now = datetime.now().isoformat()

    # Collect rows per (asset_name, date) — keep the last seen value to handle duplicates
    seen: dict[tuple[str, str], float] = {}

    for ev in events:
        country = (ev.get("country") or ev.get("countryCode") or "").upper()
        # Accept events tagged as India or with no country tag (some MC events are untagged)
        if country and country not in ("INR", "IND", "IN", ""):
            continue

        event_name = ev.get("eventName") or ev.get("name") or ""
        asset_name = _classify_event(event_name)
        if not asset_name:
            continue

        iso = _parse_event_date(ev.get("date") or ev.get("eventDate") or "")
        if not iso:
            continue
        if iso < cutoff.isoformat():
            continue

        actual_raw = ev.get("actual") or ev.get("actualValue") or ""
        value = _parse_numeric(actual_raw)
        if value is None:
            # Try "previous" as fallback only if actual is blank
            value = _parse_numeric(ev.get("previous") or "")
        if value is None:
            continue

        seen[(asset_name, iso)] = value

    if not seen:
        print("[IndiaMacro] eco-calendar: no matching India macro events found in actuals feed")
        return {}

    rows = [
        (date, asset, val, None, None, now)
        for (asset, date), val in seen.items()
    ]
    _upsert_rows(rows)

    # Return latest value per asset for the summary line
    latest: dict[str, float] = {}
    for (asset, date), val in sorted(seen.items()):  # sorted → later dates overwrite earlier
        latest[asset] = val
    return latest


# ─── Fetch RBI Repo Rate from MC interest-rates feed ──────────────────────────

def _fetch_repo_rate() -> float | None:
    """
    Fetch the MC premarket interest-rates section and extract the RBI repo rate.
    The same endpoint used by global_macro_fetcher for bond yields; the IR section
    includes central bank policy rates.
    """
    try:
        resp = cffi_req.get(_IR_URL, headers=HEADERS, impersonate="chrome110", timeout=15)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:
        print(f"[IndiaMacro] WARN repo rate fetch error: {exc}")
        return None

    if not payload.get("success") or not payload.get("data"):
        return None

    data = payload["data"]
    # The data may be a list of rate items or a nested dict
    items = data if isinstance(data, list) else []
    if not items and isinstance(data, dict):
        # Try common keys
        for k in ("rateList", "rates", "interestRates", "globalRates"):
            if isinstance(data.get(k), list):
                items = data[k]
                break

    for item in items:
        name = (item.get("name") or item.get("country") or "").lower()
        if "india" in name or "rbi" in name or "repo" in name or "inr" in name:
            try:
                return float(item.get("ltp") or item.get("rate") or item.get("value"))
            except (TypeError, ValueError):
                continue

    return None


def process_repo_rate(india_10y: float | None) -> dict[str, float]:
    """
    Fetch RBI repo rate, compute yield-curve spread if India 10Y is available,
    and write both to macro_asset_prices. Returns {asset_name: value}.
    """
    repo = _fetch_repo_rate()
    if repo is None:
        # Fallback: check eco_calendar for RBI policy events
        repo = _fetch_repo_from_eco_calendar()

    if repo is None:
        print("[IndiaMacro] WARN: could not determine RBI repo rate from any source")
        return {}

    today = datetime.today().strftime("%Y-%m-%d")
    now = datetime.now().isoformat()
    rows = [(today, "RBI_REPO_RATE", repo, None, None, now)]

    result = {"RBI_REPO_RATE": repo}

    if india_10y is not None:
        spread = round(india_10y - repo, 4)
        rows.append((today, "INDIA_10Y_MINUS_REPO", spread, None, None, now))
        result["INDIA_10Y_MINUS_REPO"] = spread

    _upsert_rows(rows)
    return result


def _fetch_repo_from_eco_calendar() -> float | None:
    """
    Fallback: query the already-stored eco_calendar table for recent RBI policy events.
    """
    cutoff = (datetime.today() - timedelta(days=90)).strftime("%Y-%m-%d")
    try:
        rows = query_all(
            """SELECT actual FROM eco_calendar
               WHERE (LOWER(event_name) LIKE '%repo%'
                   OR LOWER(event_name) LIKE '%rbi%'
                   OR LOWER(event_name) LIKE '%policy rate%')
                 AND event_date >= ?
                 AND actual IS NOT NULL AND actual != ''
               ORDER BY event_date DESC
               LIMIT 1""",
            [cutoff],
        )
        if rows:
            return _parse_numeric(rows[0]["actual"] or rows[0][0])
    except Exception as exc:
        print(f"[IndiaMacro] WARN eco_calendar repo fallback error: {exc}")
    return None


def _get_latest_india_10y() -> float | None:
    """Read today's (or most recent) INDIA_10Y from macro_asset_prices."""
    try:
        row = query_all(
            """SELECT close FROM macro_asset_prices
               WHERE symbol = 'INDIA_10Y'
               ORDER BY date DESC
               LIMIT 1""",
        )
        if row:
            return float(row[0]["close"] or row[0][0])
    except Exception:
        pass
    return None


# ─── Entry point ───────────────────────────────────────────────────────────────

def main(days: int = 60) -> None:
    print(f"[IndiaMacro] Fetching India macro indicators (last {days} days)...")

    # 1. Eco-calendar actuals → PMI, GST, IIP, Auto Sales
    eco_results = process_eco_calendar_actuals(days)

    # 2. Repo rate + yield spread
    india_10y = _get_latest_india_10y()
    rate_results = process_repo_rate(india_10y)

    all_results = {**eco_results, **rate_results}

    if all_results:
        summary_parts = [f"{k}={v}" for k, v in sorted(all_results.items())]
        print(f"[IndiaMacro] Updated: {', '.join(summary_parts)}")
    else:
        print("[IndiaMacro] No indicators updated — check API availability")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Fetch India macro indicators")
    parser.add_argument("--days", type=int, default=60,
                        help="Number of past days of eco-calendar actuals to scan (default: 60)")
    args = parser.parse_args()
    main(args.days)
