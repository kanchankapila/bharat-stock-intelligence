#!/usr/bin/env python3
"""
Tickertape scorecard client — shared by tickertape_scorecard_fetcher.py.

Live-verified 2026-07-05: api.tickertape.in/stocks/scorecard/{sid} returns
category objects (Performance/Valuation/Growth/Profitability among them,
type="score") — but the numeric score.value is premium-gated and always
null without a paid Tickertape login (confirmed across multiple stocks).
What IS available unauthenticated is a categorical `tag` per category
(observed values: "Low"/"Avg"/"High" for the type="score" categories) —
real, per-stock-differentiated signal, just ordinal instead of numeric.
tickertape_scorecard_fetcher.py stores the ordinal-encoded tag, not a
numeric score.

sid is resolved via scripts/stocklist.json's tickertape_sid field
(populated by scripts/enrich_stocklist_tickertape.py), not live per-stock
lookup — see that script for how sid is obtained.
"""

import json
from pathlib import Path

import requests

SCORECARD_URL = "https://analyze.api.tickertape.in/stocks/scorecard/{sid}"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}
# Exported for the caller to apply to their own requests.Session once at
# creation time (e.g. session.headers.update(HEADERS)), then pass that
# session into fetch_scorecard() — matches the et_stats_client.py pattern.

RATE_LIMIT_SEC = 0.3

_STOCKLIST_PATH = Path(__file__).resolve().parents[2] / "scripts" / "stocklist.json"
_symbol_to_sid: dict[str, str] | None = None


def load_tickertape_sid_map() -> dict[str, str]:
    """symbol (uppercase) -> tickertape_sid, loaded once from scripts/stocklist.json.
    Only includes entries with a non-empty tickertape_sid (most stocks won't
    have one until scripts/enrich_stocklist_tickertape.py has been run)."""
    global _symbol_to_sid
    if _symbol_to_sid is not None:
        return _symbol_to_sid

    with open(_STOCKLIST_PATH, encoding="utf-8") as f:
        rows = json.load(f)

    _symbol_to_sid = {
        row["symbol"].upper(): row["tickertape_sid"]
        for row in rows
        if row.get("symbol") and row.get("tickertape_sid")
    }
    return _symbol_to_sid


def fetch_scorecard(sid: str, session: requests.Session) -> list[dict] | None:
    """Fetch the scorecard `data` array for one stock. Returns None on
    failure or an empty response."""
    try:
        r = session.get(SCORECARD_URL.format(sid=sid), timeout=15)
        if r.status_code != 200:
            print(f"  [Tickertape scorecard] sid={sid} HTTP {r.status_code}")
            return None
        data = r.json().get("data", [])
        return data if data else None
    except Exception as e:
        print(f"  [Tickertape scorecard] error for sid={sid}: {e}")
        return None
    finally:
        import time
        time.sleep(RATE_LIMIT_SEC)
