#!/usr/bin/env python3
"""
Earnings Beat/Miss Fetcher
==========================
Fetches quarterly EPS beat/miss/inline history from MoneyControl for all active
stocks with a mcsymbol, and stores results in stock_earnings_beats.

Source: https://api.moneycontrol.com/mcapi/v1/stock/estimates/hits-misses
  - `type` field encodes beat/miss: "positive" | "negative" | "inline"
  - `estimates` and `surprise` fields are locked behind auth; only `type` is free.

Run: python earnings_surprise_fetcher.py
     python earnings_surprise_fetcher.py --limit 10   # probe first 10 stocks
     python earnings_surprise_fetcher.py --symbol INFY
"""

import os
import sys
import time
import argparse
import datetime

from sqlalchemy import text
from curl_cffi import requests

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from db_compat import get_engine, use_postgres

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}

BASE_URL = (
    "https://api.moneycontrol.com/mcapi/v1/stock/estimates/hits-misses"
    "?deviceType=W&scId={scid}&ex=N&type=eps&financialType=S"
)

# beat = +1, inline = 0, miss = -1
TYPE_MAP = {"positive": 1, "inline": 0, "negative": -1}

RATE_LIMIT_SEC = 0.8   # ~75 req/min, well within MC limits
RETRY_DELAY_SEC = 3
MAX_RETRIES = 3


def _fetch_beats(session, mcsymbol: str) -> list[dict] | None:
    url = BASE_URL.format(scid=mcsymbol)
    for attempt in range(MAX_RETRIES):
        try:
            r = session.get(url, headers=HEADERS, timeout=10, impersonate="chrome110")
            if r.status_code == 429:
                time.sleep(RETRY_DELAY_SEC * (attempt + 1))
                continue
            if r.status_code != 200:
                return None
            payload = r.json()
            if payload.get("success") != 1:
                return None
            return payload.get("data", {}).get("list", [])
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY_SEC)
            else:
                print(f"  [WARN] fetch failed for {mcsymbol}: {e}")
                return None
    return None


def _quarter_to_date(quarter_str: str) -> str | None:
    """Convert 'Mar 2026' → '2026-03-31', 'Dec 2025' → '2025-12-31', etc."""
    MONTH_END = {
        "Mar": "03-31", "Jun": "06-30", "Sep": "09-30", "Dec": "12-31",
    }
    parts = quarter_str.strip().split()
    if len(parts) != 2:
        return None
    mon, yr = parts[0], parts[1]
    suffix = MONTH_END.get(mon)
    if not suffix:
        return None
    return f"{yr}-{suffix}"


def upsert_beats(conn, symbol: str, rows: list[dict]) -> int:
    count = 0
    for item in rows:
        quarter_date = _quarter_to_date(item.get("quarter", ""))
        if not quarter_date:
            continue
        beat_type_str = item.get("type", "inline")
        beat_score = TYPE_MAP.get(beat_type_str, 0)
        eps_actual_raw = item.get("actual", "")
        try:
            eps_actual = float(eps_actual_raw) if eps_actual_raw not in ("", None) else None
        except (ValueError, TypeError):
            eps_actual = None

        if use_postgres:
            conn.execute(text("""
                INSERT INTO stock_earnings_beats
                    (symbol, quarter_date, beat_type, beat_score, eps_actual, fetched_at)
                VALUES (:sym, :qd, :bt, :bs, :ea, now())
                ON CONFLICT (symbol, quarter_date)
                DO UPDATE SET beat_type = EXCLUDED.beat_type,
                              beat_score = EXCLUDED.beat_score,
                              eps_actual = EXCLUDED.eps_actual,
                              fetched_at = now()
            """), {"sym": symbol, "qd": quarter_date, "bt": beat_type_str,
                   "bs": beat_score, "ea": eps_actual})
        else:
            conn.execute(text("""
                INSERT OR REPLACE INTO stock_earnings_beats
                    (symbol, quarter_date, beat_type, beat_score, eps_actual, fetched_at)
                VALUES (:sym, :qd, :bt, :bs, :ea, CURRENT_TIMESTAMP)
            """), {"sym": symbol, "qd": quarter_date, "bt": beat_type_str,
                   "bs": beat_score, "ea": eps_actual})
        count += 1
    return count


def run(limit: int | None = None, symbol_filter: str | None = None) -> None:
    engine = get_engine()
    with engine.connect() as conn:
        if symbol_filter:
            stocks = conn.execute(
                text("SELECT symbol, mcsymbol FROM nse_stocks WHERE symbol = :s AND mcsymbol IS NOT NULL AND mcsymbol != ''"),
                {"s": symbol_filter.upper()},
            ).fetchall()
        else:
            stocks = conn.execute(
                text("SELECT symbol, mcsymbol FROM nse_stocks WHERE status = 'ACTIVE' AND mcsymbol IS NOT NULL AND mcsymbol != '' ORDER BY symbol"),
            ).fetchall()

        if limit:
            stocks = stocks[:limit]

        print(f"[EARNINGS] Fetching beat/miss history for {len(stocks)} stocks …")
        session = requests.Session()
        total_rows = 0

        for i, (symbol, mcsymbol) in enumerate(stocks, 1):
            rows = _fetch_beats(session, mcsymbol)
            if rows is None:
                print(f"  [{i}/{len(stocks)}] {symbol} ({mcsymbol}) — skip (fetch failed)")
                time.sleep(RATE_LIMIT_SEC)
                continue

            n = upsert_beats(conn, symbol, rows)
            conn.commit()
            total_rows += n
            if i % 20 == 0 or i == len(stocks):
                print(f"  [{i}/{len(stocks)}] {symbol}: {n} quarters upserted (total={total_rows})")
            time.sleep(RATE_LIMIT_SEC)

        print(f"[EARNINGS] Done. {total_rows} quarter rows upserted for {len(stocks)} stocks.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MoneyControl earnings beat/miss fetcher")
    parser.add_argument("--limit",  type=int, default=None, help="Fetch only first N stocks (for testing)")
    parser.add_argument("--symbol", default=None, help="Fetch a single NSE symbol")
    args = parser.parse_args()
    run(limit=args.limit, symbol_filter=args.symbol)
