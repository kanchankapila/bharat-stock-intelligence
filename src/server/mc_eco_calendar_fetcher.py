#!/usr/bin/env python3
"""
Fetch upcoming economic calendar events from MoneyControl and persist to:
  - eco_calendar          — raw event rows for reference/display
  - macro_asset_prices    — 3 summary count features for ML consumption
"""

import sys
from datetime import datetime, timedelta

from curl_cffi import requests as cffi_req

from db_compat import connect, executemany, execute

BASE_URL = (
    "https://api.moneycontrol.com/mcapi/v1/ecalendar/get-upcoming-event-data"
    "?page={page}&pageSize=20"
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Accept": "application/json",
}

PAGES_TO_FETCH = 3


# ─── Schema bootstrap ─────────────────────────────────────────────────────────

def ensure_schema() -> None:
    try:
        execute("""
            CREATE TABLE IF NOT EXISTS eco_calendar (
                calendar_id   TEXT PRIMARY KEY,
                event_date    TEXT,
                event_time    TEXT,
                country       TEXT,
                country_name  TEXT,
                event_name    TEXT,
                category      TEXT,
                impact        INTEGER,
                actual        TEXT,
                previous      TEXT,
                consensus     TEXT,
                reference     TEXT,
                symbol        TEXT,
                fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
    except Exception as exc:
        print(f"[EcoCalendar] WARN ensure_schema eco_calendar: {exc}")


# ─── Fetch ────────────────────────────────────────────────────────────────────

def _parse_event_date(date_str: str) -> str | None:
    """Convert 'Friday, Jun 26, 2026' or 'Friday, June 26, 2026' to ISO 'YYYY-MM-DD'."""
    for fmt in ("%A, %b %d, %Y", "%A, %B %d, %Y"):
        try:
            return datetime.strptime(date_str.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def fetch_events() -> list[dict]:
    """Fetch pages 1–PAGES_TO_FETCH and return a flat list of event dicts."""
    events: list[dict] = []
    for page in range(1, PAGES_TO_FETCH + 1):
        url = BASE_URL.format(page=page)
        try:
            resp = cffi_req.get(url, headers=HEADERS, impersonate="chrome110", timeout=15)
            resp.raise_for_status()
            payload = resp.json()
        except Exception as exc:
            print(f"[EcoCalendar] WARN page {page} fetch error: {exc}")
            break

        if not payload.get("success"):
            print(f"[EcoCalendar] WARN page {page} returned success=0")
            break

        for day_block in payload.get("data", []):
            for ev in day_block.get("eventList", []):
                events.append(ev)

    return events


# ─── Persist ──────────────────────────────────────────────────────────────────

def _upsert_eco_calendar(events: list[dict]) -> None:
    now = datetime.now().isoformat()
    rows = [
        (
            str(ev.get("calendarId", "")),
            _parse_event_date(ev.get("date", "")) or ev.get("date", ""),
            ev.get("time", ""),
            ev.get("country", ""),
            ev.get("countryName", ""),
            ev.get("eventName", ""),
            ev.get("category", ""),
            ev.get("impact"),
            ev.get("actual", ""),
            ev.get("previous", ""),
            ev.get("consensus", ""),
            ev.get("reference", ""),
            ev.get("symbol", ""),
            now,
        )
        for ev in events
        if ev.get("calendarId")
    ]
    if not rows:
        return

    executemany(
        """INSERT INTO eco_calendar
               (calendar_id, event_date, event_time, country, country_name,
                event_name, category, impact, actual, previous, consensus,
                reference, symbol, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(calendar_id) DO UPDATE SET
             event_date=excluded.event_date,
             event_time=excluded.event_time,
             actual=excluded.actual,
             previous=excluded.previous,
             consensus=excluded.consensus,
             impact=excluded.impact,
             fetched_at=excluded.fetched_at""",
        rows,
    )


def _compute_and_upsert_macro_features(events: list[dict]) -> tuple[int, int, int]:
    """
    Compute 3 summary counts and upsert into macro_asset_prices.
    Returns (high_impact_3d, india_7d, critical_1d).
    """
    today = datetime.today().date()
    t3 = today + timedelta(days=3)
    t7 = today + timedelta(days=7)
    tomorrow = today + timedelta(days=1)

    high_impact_3d = 0   # impact >= 2, event_date in [today, today+3]
    india_7d = 0          # country in INR/IND, event_date in [today, today+7]
    critical_1d = 0       # impact == 3, event_date == tomorrow

    for ev in events:
        raw_date = ev.get("date", "")
        iso = _parse_event_date(raw_date)
        if not iso:
            continue
        try:
            ev_date = datetime.strptime(iso, "%Y-%m-%d").date()
        except ValueError:
            continue

        if ev_date < today:
            continue  # skip past events

        impact = ev.get("impact") or 0
        country = (ev.get("country") or "").upper()

        if today <= ev_date <= t3 and impact >= 2:
            high_impact_3d += 1
        if today <= ev_date <= t7 and country in ("INR", "IND"):
            india_7d += 1
        if ev_date == tomorrow and impact == 3:
            critical_1d += 1

    today_str = today.isoformat()
    now = datetime.now().isoformat()

    feature_rows = [
        (today_str, "HIGH_IMPACT_EVENTS_3D", float(high_impact_3d), None, None, now),
        (today_str, "INDIA_EVENTS_7D",       float(india_7d),       None, None, now),
        (today_str, "CRITICAL_EVENTS_1D",    float(critical_1d),    None, None, now),
    ]

    executemany(
        """INSERT INTO macro_asset_prices
               (date, symbol, close, ret_1d, ret_5d, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(date, symbol) DO UPDATE SET
             close=excluded.close,
             fetched_at=excluded.fetched_at""",
        feature_rows,
    )

    return high_impact_3d, india_7d, critical_1d


# ─── Entry point ──────────────────────────────────────────────────────────────

def main() -> None:
    ensure_schema()

    events = fetch_events()

    # Filter to upcoming only for feature computation (raw store keeps all)
    today_str = datetime.today().date().isoformat()
    upcoming = [
        ev for ev in events
        if (_parse_event_date(ev.get("date", "")) or "") >= today_str
    ]

    _upsert_eco_calendar(events)
    high3, india7, crit1 = _compute_and_upsert_macro_features(upcoming)

    print(
        f"[EcoCalendar] Fetched {len(upcoming)} upcoming events. "
        f"High-impact next 3d: {high3}, India events 7d: {india7}, "
        f"Critical events 1d: {crit1}"
    )


if __name__ == "__main__":
    main()
