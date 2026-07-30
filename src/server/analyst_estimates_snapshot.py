"""
Analyst Estimates Snapshotter
==============================
Fetches analyst consensus, price targets, and EPS estimates from MoneyControl
for all NSE stocks that have an mcsymbol in the nse_stocks table. Writes
point-in-time snapshots into analyst_estimates_history(symbol, as_of_date, ...)
so ml_ensemble.load_training_data can join them as-of each signal_date (leak-free).

Run:  python analyst_estimates_snapshot.py
      python analyst_estimates_snapshot.py --as-of 2026-06-22
      python analyst_estimates_snapshot.py --symbols RELIANCE,TCS
"""

import argparse
import datetime
import time
from typing import Callable, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from db_compat import execute, query_all
from fetch_utils import retry_get

_BATCH_SIZE = 15
_BATCH_GAP_SEC = 0.5

# ── MoneyControl API endpoints (same ones mcApiService.ts wraps) ──────────────

_MC_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.moneycontrol.com/",
}

_URL_ANALYST  = "https://api.moneycontrol.com/mcapi/v1/stock/estimates/analyst-rating?deviceType=W&scId={scId}&ex=N"
_URL_PRICE    = "https://api.moneycontrol.com/mcapi/v1/stock/estimates/price-forecast?scId={scId}&ex=N&deviceType=W"
_URL_EARNINGS = "https://api.moneycontrol.com/mcapi/v1/stock/estimates/earning-forecast?scId={scId}&ex=N&deviceType=W&frequency=12&financialType=C"

_SLEEP_BETWEEN = 0.4   # seconds between stocks (conservative rate-limit guard)
_BATCH_SIZE    = 5     # pause every N stocks


# ── Pure parsing functions (no I/O, fully testable) ───────────────────────────

def parse_analyst_rating(data: Optional[dict]) -> dict:
    """Extract counts from McAnalystRating response payload.
    Returns dict with all keys set to None on missing/malformed input."""
    empty = {"n_analysts": None, "final_rating": None,
             "buy_count": None, "hold_count": None, "sell_count": None}
    if not data:
        return empty

    n_analysts: Optional[int] = None
    try:
        v = int(data.get("analystCount") or 0)
        n_analysts = v if v > 0 else None
    except (TypeError, ValueError):
        pass

    final_rating = data.get("finalRating") or None

    buy_count = hold_count = sell_count = None
    for r in (data.get("ratings") or []):
        name = (r.get("name") or "").upper()
        try:
            cnt = int(r.get("value") or 0)
        except (TypeError, ValueError):
            cnt = 0
        if "BUY" in name or "OUTPERFORM" in name:
            buy_count = (buy_count or 0) + cnt
        elif "HOLD" in name or "NEUTRAL" in name:
            hold_count = (hold_count or 0) + cnt
        elif "SELL" in name or "UNDERPERFORM" in name:
            sell_count = (sell_count or 0) + cnt

    return {
        "n_analysts":   n_analysts,
        "final_rating": final_rating,
        "buy_count":    buy_count,
        "hold_count":   hold_count,
        "sell_count":   sell_count,
    }


def parse_price_forecast(data: Optional[dict]) -> dict:
    """Extract target high/mean/low from McPriceForecast response payload."""
    empty = {"target_high": None, "target_mean": None, "target_low": None}
    if not data:
        return empty

    def _f(key: str) -> Optional[float]:
        try:
            v = float(data.get(key) or 0)
            return v if v != 0.0 else None
        except (TypeError, ValueError):
            return None

    return {"target_high": _f("high"), "target_mean": _f("mean"), "target_low": _f("low")}


def parse_earnings_forecast(data: Optional[dict]) -> dict:
    """Extract next-period EPS and revenue estimate from McEarningsForecast response payload.
    'Next period' = the first entry in the array where actual is empty or null (future estimate)."""
    empty = {"eps_est_next": None, "revenue_est_next": None}
    if not data:
        return empty

    def _next_avg(series) -> Optional[float]:
        for entry in (series or []):
            if not entry.get("actual"):
                try:
                    v = float(entry.get("avg") or 0)
                    return v if v != 0.0 else None
                except (TypeError, ValueError):
                    return None
        return None

    return {
        "eps_est_next":     _next_avg(data.get("eps")),
        "revenue_est_next": _next_avg(data.get("revenue")),
    }


# ── HTTP fetch ────────────────────────────────────────────────────────────────

def _mc_get(url: str, session: requests.Session) -> Optional[dict]:
    """Fetch a MoneyControl JSON endpoint; return the .data payload or None."""
    try:
        resp = retry_get(session, url, headers=_MC_HEADERS, timeout=10)
        j = resp.json()
        if j.get("success") == 1:
            return j.get("data")
    except Exception:
        pass
    return None


def _fetch_symbol(mcsymbol: str, session: requests.Session) -> dict:
    """Fetch and merge analyst-rating + price-forecast + earnings-forecast for one stock."""
    result: dict = {}
    result.update(parse_analyst_rating(_mc_get(_URL_ANALYST.format(scId=mcsymbol), session)))
    result.update(parse_price_forecast(_mc_get(_URL_PRICE.format(scId=mcsymbol), session)))
    result.update(parse_earnings_forecast(_mc_get(_URL_EARNINGS.format(scId=mcsymbol), session)))
    return result


# ── SQL ───────────────────────────────────────────────────────────────────────

_SELECT_SYMBOLS = """
    SELECT DISTINCT symbol, mcsymbol
    FROM nse_stocks
    WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
"""
_SELECT_SYMBOLS_FILTER = """
    SELECT symbol, mcsymbol
    FROM nse_stocks
    WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
      AND symbol IN ({placeholders})
"""
_DELETE = "DELETE FROM analyst_estimates_history WHERE symbol = ? AND as_of_date = ?"
_INSERT = """
    INSERT INTO analyst_estimates_history
        (symbol, as_of_date, n_analysts, final_rating, buy_count, hold_count, sell_count,
         target_high, target_mean, target_low, eps_est_next, revenue_est_next)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


# ── Entry point ───────────────────────────────────────────────────────────────

def run(
    as_of: Optional[str] = None,
    symbols: Optional[list] = None,
    fetch_fn: Optional[Callable] = None,
) -> int:
    """Snapshot analyst estimates for `symbols` (or all NSE stocks with mcsymbol).
    Idempotent per (symbol, as_of_date): deletes then re-inserts today's row.
    `fetch_fn(mcsymbol) -> dict` is injectable for tests; defaults to live MC fetch.
    Returns count of rows written."""
    as_of  = as_of  or datetime.date.today().isoformat()
    use_live = fetch_fn is None

    if symbols:
        placeholders = ",".join(["?"] * len(symbols))
        rows = query_all(
            _SELECT_SYMBOLS_FILTER.format(placeholders=placeholders),
            tuple(symbols),
        )
    else:
        rows = query_all(_SELECT_SYMBOLS)

    session = requests.Session()
    session.headers.update(_MC_HEADERS)

    written = 0
    done = 0

    def _process_one(row):
        symbol, mcsymbol = row["symbol"], row["mcsymbol"]
        if fetch_fn:
            fields = fetch_fn(mcsymbol)
        else:
            fields = _fetch_symbol(mcsymbol, session)
        return symbol, fields

    for batch_start in range(0, len(rows), _BATCH_SIZE):
        batch = rows[batch_start:batch_start + _BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_process_one, r) for r in batch]
            for fut in as_completed(futures):
                symbol, fields = fut.result()
                done += 1
                if all(v is None for v in fields.values()):
                    continue

                execute(_DELETE, (symbol, as_of))
                execute(_INSERT, (
                    symbol, as_of,
                    fields.get("n_analysts"),
                    fields.get("final_rating"),
                    fields.get("buy_count"),
                    fields.get("hold_count"),
                    fields.get("sell_count"),
                    fields.get("target_high"),
                    fields.get("target_mean"),
                    fields.get("target_low"),
                    fields.get("eps_est_next"),
                    fields.get("revenue_est_next"),
                ))
                written += 1
        if use_live:
            time.sleep(_BATCH_GAP_SEC)

    print(f"[ANALYST-SNAP] Wrote {written}/{len(rows)} analyst snapshots as_of {as_of}.")
    return written


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Analyst estimates point-in-time snapshotter")
    parser.add_argument("--as-of",   help="Snapshot date YYYY-MM-DD (default: today)")
    parser.add_argument("--symbols", help="Comma-separated NSE symbols (default: all with mcsymbol)")
    args = parser.parse_args()
    syms = [s.strip() for s in args.symbols.split(",")] if args.symbols else None
    run(as_of=args.as_of, symbols=syms)
