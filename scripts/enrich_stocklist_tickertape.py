#!/usr/bin/env python3
"""
One-time (re-runnable, idempotent) enrichment of scripts/stocklist.json with
Tickertape's per-stock `sid`, resolved via Tickertape's bulk stock-list
endpoint (https://api.tickertape.in/stocks/list — single unauthenticated
request, ~5,793 stocks, no pagination) joined on ISIN against stocklist.json's
existing isin field.

ISIN is used as the join key (not symbol/ticker string matching) since it's
the one universal identifier both sides already carry cleanly — avoids
suffix/casing mismatches between NSE symbols and Tickertape's ticker field.

Run:
  python scripts/enrich_stocklist_tickertape.py
"""

import json
from pathlib import Path

import requests

STOCKLIST_PATH = Path(__file__).resolve().parent / "stocklist.json"
TICKERTAPE_LIST_URL = "https://api.tickertape.in/stocks/list"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def fetch_tickertape_list() -> list[dict]:
    r = requests.get(TICKERTAPE_LIST_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json().get("data", [])


def join_by_isin(stocklist: list[dict], tickertape_list: list[dict]) -> list[dict]:
    """Pure function: does not mutate inputs, returns a new list of dicts.
    Adds `tickertape_sid` only to entries where both sides have a matching,
    non-empty ISIN — entries with no match are left untouched (no key added)."""
    isin_to_sid = {
        row["isin"]: row["sid"]
        for row in tickertape_list
        if row.get("isin") and row.get("sid")
    }

    result = []
    for entry in stocklist:
        updated = dict(entry)
        isin = entry.get("isin")
        if isin and isin in isin_to_sid:
            updated["tickertape_sid"] = isin_to_sid[isin]
        result.append(updated)
    return result


def main() -> None:
    with open(STOCKLIST_PATH, encoding="utf-8") as f:
        stocklist = json.load(f)

    print(f"[EnrichTickertape] Fetching Tickertape bulk stock list...")
    tickertape_list = fetch_tickertape_list()
    print(f"[EnrichTickertape] Got {len(tickertape_list)} Tickertape entries.")

    enriched = join_by_isin(stocklist, tickertape_list)
    matched = sum(1 for e in enriched if "tickertape_sid" in e)
    print(f"[EnrichTickertape] Matched {matched}/{len(enriched)} stocklist entries by ISIN.")

    with open(STOCKLIST_PATH, "w", encoding="utf-8") as f:
        json.dump(enriched, f, indent=2, ensure_ascii=False)
    print(f"[EnrichTickertape] Wrote {STOCKLIST_PATH}")


if __name__ == "__main__":
    main()
