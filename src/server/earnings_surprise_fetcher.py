#!/usr/bin/env python3
"""
Earnings Surprise Fetcher
==========================
Fetches annual EPS actual vs consensus estimates from MoneyControl and computes
real surprise percentages. Stores results in stock_earnings_beats.

Two endpoints used per stock:

  1. earning-forecast (primary) — annual EPS: actual + analyst avg/high/low consensus.
     Gives surprise_pct = (actual − avg) / avg × 100 for completed years.
     URL: /mcapi/v1/stock/estimates/earning-forecast?scId={mcsymbol}&ex=N&deviceType=W&frequency=12&financialType=S

  2. hits-misses (quarterly supplement) — quarterly beat/miss/inline classification.
     No magnitude (estimates locked), but provides recency at quarterly cadence.
     URL: /mcapi/v1/stock/estimates/hits-misses?deviceType=W&scId={mcsymbol}&ex=N&type=eps&financialType=S

Beat scoring:
  - Annual rows: beat_score derived from surprise_pct threshold (±2%).
    > +2% → +1 (beat), < −2% → −1 (miss), else 0 (inline).
  - Quarterly rows: beat_score from type field (+1/0/−1), surprise_pct NULL.
  - period_type column: 'annual' | 'quarterly'

Run: python earnings_surprise_fetcher.py
     python earnings_surprise_fetcher.py --limit 10
     python earnings_surprise_fetcher.py --symbol INFY
"""

import os
import sys
import time
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

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

FORECAST_URL = (
    "https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast"
    "?scId={scid}&ex=N&deviceType=W&frequency=12&financialType=S"
)
HITS_URL = (
    "https://api.moneycontrol.com/mcapi/v1/stock/estimates/hits-misses"
    "?deviceType=W&scId={scid}&ex=N&type=eps&financialType=S"
)

BEAT_THRESHOLD_PCT = 2.0   # |surprise| < 2% → inline; avoids noise from rounding

TYPE_MAP = {"positive": 1, "inline": 0, "negative": -1}

RATE_LIMIT_SEC = 0.5    # two requests per stock → effective ~0.25 req/s per URL
RETRY_DELAY_SEC = 3
MAX_RETRIES = 3
BATCH_SIZE     = 15
BATCH_GAP_SEC  = 0.5


# ── helpers ────────────────────────────────────────────────────────────────────

def _get(session, url: str) -> dict | None:
    for attempt in range(MAX_RETRIES):
        try:
            r = session.get(url, headers=HEADERS, timeout=10, impersonate="chrome110")
            if r.status_code == 429:
                time.sleep(RETRY_DELAY_SEC * (attempt + 1))
                continue
            if r.status_code != 200:
                return None
            payload = r.json()
            return payload if payload.get("success") == 1 else None
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY_SEC)
            else:
                print(f"  [WARN] fetch failed ({url[:60]}…): {e}")
    return None


def _to_float(val) -> float | None:
    if val in ("", None):
        return None
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def _period_to_date(period_str: str) -> str | None:
    """'Mar 2026' → '2026-03-31', 'Dec 2025' → '2025-12-31'"""
    MONTH_END = {"Mar": "03-31", "Jun": "06-30", "Sep": "09-30", "Dec": "12-31"}
    parts = period_str.strip().split()
    if len(parts) != 2:
        return None
    mon, yr = parts
    suffix = MONTH_END.get(mon)
    return f"{yr}-{suffix}" if suffix else None


# ── per-stock fetch ─────────────────────────────────────────────────────────────

def _annual_rows(session, mcsymbol: str) -> list[dict]:
    """
    Returns list of dicts ready for upsert, derived from the earning-forecast endpoint.
    Only includes rows where `actual` is non-empty (completed fiscal years).
    """
    payload = _get(session, FORECAST_URL.format(scid=mcsymbol))
    if not payload:
        return []

    eps_list = payload.get("data", {}).get("eps", [])
    rows = []
    for item in eps_list:
        actual = _to_float(item.get("actual"))
        if actual is None:
            continue   # future year — no surprise to compute
        avg  = _to_float(item.get("avg"))
        high = _to_float(item.get("high"))
        low  = _to_float(item.get("low"))
        period_date = _period_to_date(item.get("date", ""))
        if not period_date:
            continue

        if avg and avg != 0:
            surprise_pct = round((actual - avg) / avg * 100, 2)
        else:
            surprise_pct = None

        if surprise_pct is not None:
            beat_score = 1 if surprise_pct > BEAT_THRESHOLD_PCT else (-1 if surprise_pct < -BEAT_THRESHOLD_PCT else 0)
            beat_type  = "positive" if beat_score > 0 else ("negative" if beat_score < 0 else "inline")
        else:
            beat_score, beat_type = 0, "inline"

        rows.append({
            "period_date":   period_date,
            "period_type":   "annual",
            "beat_type":     beat_type,
            "beat_score":    beat_score,
            "eps_actual":    actual,
            "eps_avg":       avg,
            "eps_high":      high,
            "eps_low":       low,
            "surprise_pct":  surprise_pct,
        })
    return rows


def _quarterly_rows(session, mcsymbol: str) -> list[dict]:
    """
    Returns list of dicts from the hits-misses endpoint (quarterly cadence).
    Surprise % is not available (locked), but provides recent beat/miss classification.
    """
    payload = _get(session, HITS_URL.format(scid=mcsymbol))
    if not payload:
        return []

    rows = []
    for item in payload.get("data", {}).get("list", []):
        period_date = _period_to_date(item.get("quarter", ""))
        if not period_date:
            continue
        beat_type  = item.get("type", "inline")
        beat_score = TYPE_MAP.get(beat_type, 0)
        eps_actual = _to_float(item.get("actual"))
        rows.append({
            "period_date":  period_date,
            "period_type":  "quarterly",
            "beat_type":    beat_type,
            "beat_score":   beat_score,
            "eps_actual":   eps_actual,
            "eps_avg":      None,
            "eps_high":     None,
            "eps_low":      None,
            "surprise_pct": None,
        })
    return rows


# ── db write ────────────────────────────────────────────────────────────────────

def upsert_rows(conn, symbol: str, rows: list[dict]) -> int:
    count = 0
    for r in rows:
        if use_postgres():
            conn.execute(text("""
                INSERT INTO stock_earnings_beats
                    (symbol, quarter_date, period_type, beat_type, beat_score,
                     eps_actual, eps_avg, eps_high, eps_low, surprise_pct, fetched_at)
                VALUES (:sym, :pd, :pt, :bt, :bs, :ea, :ag, :hi, :lo, :sp, now())
                ON CONFLICT (symbol, quarter_date)
                DO UPDATE SET period_type  = EXCLUDED.period_type,
                              beat_type    = EXCLUDED.beat_type,
                              beat_score   = EXCLUDED.beat_score,
                              eps_actual   = COALESCE(EXCLUDED.eps_actual, stock_earnings_beats.eps_actual),
                              eps_avg      = COALESCE(EXCLUDED.eps_avg,    stock_earnings_beats.eps_avg),
                              eps_high     = COALESCE(EXCLUDED.eps_high,   stock_earnings_beats.eps_high),
                              eps_low      = COALESCE(EXCLUDED.eps_low,    stock_earnings_beats.eps_low),
                              surprise_pct = COALESCE(EXCLUDED.surprise_pct, stock_earnings_beats.surprise_pct),
                              fetched_at   = now()
            """), {"sym": symbol, "pd": r["period_date"], "pt": r["period_type"],
                   "bt": r["beat_type"], "bs": r["beat_score"],
                   "ea": r["eps_actual"], "ag": r["eps_avg"],
                   "hi": r["eps_high"], "lo": r["eps_low"], "sp": r["surprise_pct"]})
        else:
            conn.execute(text("""
                INSERT OR REPLACE INTO stock_earnings_beats
                    (symbol, quarter_date, period_type, beat_type, beat_score,
                     eps_actual, eps_avg, eps_high, eps_low, surprise_pct, fetched_at)
                VALUES (:sym, :pd, :pt, :bt, :bs, :ea, :ag, :hi, :lo, :sp, CURRENT_TIMESTAMP)
            """), {"sym": symbol, "pd": r["period_date"], "pt": r["period_type"],
                   "bt": r["beat_type"], "bs": r["beat_score"],
                   "ea": r["eps_actual"], "ag": r["eps_avg"],
                   "hi": r["eps_high"], "lo": r["eps_low"], "sp": r["surprise_pct"]})
        count += 1
    return count


# ── main ────────────────────────────────────────────────────────────────────────

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

        print(f"[EARNINGS] Fetching EPS forecast + beat/miss for {len(stocks)} stocks in batches of {BATCH_SIZE} ({BATCH_GAP_SEC}s gap) …")
        session = requests.Session()
        total_rows = 0
        done = 0

        def _fetch_one(args):
            symbol, mcsymbol = args
            annual    = _annual_rows(session, mcsymbol)
            quarterly = _quarterly_rows(session, mcsymbol)
            annual_dates = {r["period_date"] for r in annual}
            combined = annual + [r for r in quarterly if r["period_date"] not in annual_dates]
            return symbol, mcsymbol, annual, combined

        for batch_start in range(0, len(stocks), BATCH_SIZE):
            batch = stocks[batch_start:batch_start + BATCH_SIZE]
            with ThreadPoolExecutor(max_workers=len(batch)) as pool:
                futures = [pool.submit(_fetch_one, item) for item in batch]
                for fut in as_completed(futures):
                    symbol, mcsymbol, annual, combined = fut.result()
                    done += 1
                    if not combined:
                        print(f"  [{done}/{len(stocks)}] {symbol} ({mcsymbol}) — no data")
                        continue
                    n = upsert_rows(conn, symbol, combined)
                    conn.commit()
                    total_rows += n
                    annual_with_surprise = [r for r in annual if r["surprise_pct"] is not None]
                    surprise_summary = ""
                    if annual_with_surprise:
                        spcts = [f"{r['surprise_pct']:+.1f}%" for r in sorted(annual_with_surprise, key=lambda x: x["period_date"])[-3:]]
                        surprise_summary = f" | surprise last 3yr: {', '.join(spcts)}"
                    if done % 10 == 0 or done == len(stocks):
                        print(f"  [{done}/{len(stocks)}] {symbol}: {n} periods upserted{surprise_summary} (total={total_rows})")
            time.sleep(BATCH_GAP_SEC)

        print(f"[EARNINGS] Done. {total_rows} period rows upserted for {len(stocks)} stocks.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MoneyControl earnings surprise fetcher")
    parser.add_argument("--limit",  type=int, default=None, help="Fetch only first N stocks (for testing)")
    parser.add_argument("--symbol", default=None, help="Fetch a single NSE symbol")
    args = parser.parse_args()
    run(limit=args.limit, symbol_filter=args.symbol)
