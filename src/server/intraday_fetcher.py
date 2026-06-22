"""
Intraday OHLCV Fetcher
======================
Fetches 15-minute bars from MoneyControl TechCharts API for all NSE stocks that
have an mcsymbol. Writes into intraday_ohlcv(symbol, datetime, open, high, low,
close, volume, interval) with upsert semantics.

Runs every 30 minutes during market hours via the QUEUE_INTRADAY_FETCHER BullMQ
job (cron: */30 3-10 * * 1-5 = 8:30 AM – 4:00 PM IST on weekdays).

Run standalone:
    python intraday_fetcher.py                      # last 5 days, all stocks
    python intraday_fetcher.py --lookback-days 30   # backfill 30 days
    python intraday_fetcher.py --symbols INFY TCS   # specific symbols
"""

import argparse
import datetime
import time
from typing import Callable, Optional

try:
    from curl_cffi import requests as cffi_requests
    _SESSION = cffi_requests.Session(impersonate="chrome120")

    def _http_get(url: str):
        return _SESSION.get(url, timeout=10)

except ImportError:
    import requests as _req
    _SESSION = _req.Session()
    _SESSION.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Referer": "https://www.moneycontrol.com/",
    })

    def _http_get(url: str):
        return _SESSION.get(url, timeout=10)


from db_compat import execute, executemany, query_all

_IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

_URL = (
    "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history"
    "?symbol={scId}&resolution=15&from={from_ts}&to={to_ts}&countback=500&currencyCode=INR"
)

_SELECT_SYMBOLS = """
    SELECT DISTINCT symbol, mcsymbol
    FROM nse_stocks
    WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
"""
_SELECT_SYMBOLS_FILTER = """
    SELECT symbol, mcsymbol
    FROM nse_stocks
    WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
      AND symbol IN ({ph})
"""

_UPSERT = """
    INSERT INTO intraday_ohlcv (symbol, datetime, open, high, low, close, volume, vwap, interval)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(symbol, datetime, interval) DO UPDATE SET
        open   = excluded.open,
        high   = excluded.high,
        low    = excluded.low,
        close  = excluded.close,
        volume = excluded.volume
"""


# ── Pure parsing (no I/O) ──────────────────────────────────────────────────────

def parse_bars(data: Optional[dict], symbol: str, interval: str = "15m") -> list:
    """Convert a MC TechCharts JSON payload into a list of bar dicts.
    Returns [] for missing/empty data — never raises."""
    if not data or not data.get("t"):
        return []
    t_arr = data.get("t", [])
    o_arr = data.get("o", [])
    h_arr = data.get("h", [])
    l_arr = data.get("l", [])
    c_arr = data.get("c", [])
    v_arr = data.get("v", [])
    bars = []
    for i in range(len(t_arr)):
        dt = datetime.datetime.fromtimestamp(t_arr[i], tz=_IST)
        bars.append({
            "symbol":   symbol,
            "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S+05:30"),
            "open":     float(o_arr[i]) if i < len(o_arr) and o_arr[i] is not None else None,
            "high":     float(h_arr[i]) if i < len(h_arr) and h_arr[i] is not None else None,
            "low":      float(l_arr[i]) if i < len(l_arr) and l_arr[i] is not None else None,
            "close":    float(c_arr[i]) if i < len(c_arr) and c_arr[i] is not None else None,
            "volume":   int(v_arr[i])   if i < len(v_arr) and v_arr[i] is not None else None,
            "interval": interval,
        })
    return bars


# ── Live fetch ─────────────────────────────────────────────────────────────────

def _fetch_live(mcsymbol: str, from_ts: int, to_ts: int) -> Optional[dict]:
    url = _URL.format(scId=mcsymbol, from_ts=from_ts, to_ts=to_ts)
    try:
        resp = _http_get(url)
        data = resp.json()
        if data and data.get("t"):
            return data
    except Exception:
        pass
    return None


# ── Entry point ───────────────────────────────────────────────────────────────

def run(
    lookback_days: int = 5,
    symbols: Optional[list] = None,
    fetch_fn: Optional[Callable] = None,
) -> int:
    """Fetch and upsert 15m bars for all NSE stocks with mcsymbol.
    fetch_fn(mcsymbol, from_ts, to_ts) -> dict|None  — injectable for tests.
    Returns total bars written."""
    fetch   = fetch_fn or _fetch_live
    use_live = fetch_fn is None

    to_ts   = int(time.time())
    from_ts = to_ts - lookback_days * 24 * 3600

    if symbols:
        ph   = ",".join(["?"] * len(symbols))
        rows = query_all(_SELECT_SYMBOLS_FILTER.format(ph=ph), tuple(symbols))
    else:
        rows = query_all(_SELECT_SYMBOLS)

    total = 0
    for i, row in enumerate(rows):
        symbol, mcsymbol = row["symbol"], row["mcsymbol"]
        data = fetch(mcsymbol, from_ts, to_ts)
        bars = parse_bars(data, symbol)
        if bars:
            executemany(
                _UPSERT,
                [(b["symbol"], b["datetime"], b["open"], b["high"],
                  b["low"], b["close"], b["volume"], b["interval"]) for b in bars],
            )
            total += len(bars)

        if use_live and i % 10 == 9:
            time.sleep(0.1)   # 10ms per stock avg; pause 100ms every 10

    print(f"[INTRADAY] {total} bars upserted for {len(rows)} symbols (lookback={lookback_days}d).")
    return total


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Intraday OHLCV fetcher (MC TechCharts 15m)")
    parser.add_argument("--lookback-days", type=int, default=5, help="Days of history to fetch (default 5)")
    parser.add_argument("--symbols", nargs="*", help="NSE symbols to fetch (default: all with mcsymbol)")
    args = parser.parse_args()
    run(lookback_days=args.lookback_days, symbols=args.symbols)
