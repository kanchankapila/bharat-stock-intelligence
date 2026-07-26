"""
Intraday OHLCV Fetcher
======================
Fetches 15-minute bars for all NSE stocks from two independent sources -- MoneyControl
TechCharts and Yahoo Finance's public chart API -- and writes into
intraday_ohlcv(symbol, datetime, open, high, low, close, volume, interval) with upsert
semantics.

The TechCharts `history` endpoint is keyed by the RAW NSE ticker (confirmed live:
`symbol=RELIANCE`/`symbol=SBIN` return real bars, `symbol=RI`/`symbol=SBI` --
those stocks' `mcsymbol` -- return `{"s":"error"}`), matching what
mc_ohlcv_backfill.py already does for the same endpoint. This script used to pass
`mcsymbol` instead: for the ~53 stocks where mcsymbol happens to equal the ticker
(e.g. TCS) that coincidentally worked, but for the other ~97% of the universe
(RELIANCE/mcsymbol=RI, SBIN/mcsymbol=SBI, HDFCBANK/mcsymbol=HDF01, ...) every
fetch silently returned no bars -- the job still logged success because nothing
threw. Verified live 2026-07-23: before this fix, RELIANCE's last bar was
2026-06-30 (3+ weeks stale) despite running every 30 min the whole time.

Two sources, load split in half: hitting MoneyControl alone for the full ~2400-symbol
universe every cycle risks exactly the kind of single-source overload that caused the
2026-07-26 regression (raising worker concurrency from 12 to 24 against MC alone
started producing a burst of empty responses -- see run()). Splitting the universe
between MC and Yahoo Finance's public `/v8/finance/chart` endpoint (no auth required,
verified live: 15m bars for RELIANCE and for a stock MC had zero data for) roughly
halves each source's per-cycle request count, and each symbol falls back to the other
source if its primary returns nothing -- recovering coverage neither source alone has
(MC and Yahoo don't agree on which illiquid names have recent data).

Runs every 15 minutes during market hours via the QUEUE_INTRADAY_FETCHER BullMQ
job (cron: */15 3-10 * * 1-5 = 8:30 AM – 4:00 PM IST on weekdays) -- matches the
underlying bar resolution (`resolution=15`), so there's no value fetching more
often than that.

Run standalone:
    python intraday_fetcher.py                      # last 5 days, all stocks
    python intraday_fetcher.py --lookback-days 30   # backfill 30 days
    python intraday_fetcher.py --symbols INFY TCS   # specific symbols
"""

import argparse
import datetime
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Optional

# One HTTP session per worker thread -- curl_cffi's Session (like most libcurl wrappers)
# is not guaranteed safe for concurrent requests on a single handle, so a shared module-level
# session can't be used once fetching is parallelized (see run()'s ThreadPoolExecutor).
_thread_local = threading.local()


def _get_session():
    sess = getattr(_thread_local, "session", None)
    if sess is not None:
        return sess
    try:
        from curl_cffi import requests as cffi_requests
        sess = cffi_requests.Session(impersonate="chrome120")
    except ImportError:
        import requests as _req
        sess = _req.Session()
        sess.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.moneycontrol.com/",
        })
    _thread_local.session = sess
    return sess


def _http_get(url: str):
    return _get_session().get(url, timeout=10)


from db_compat import execute, executemany, query_all

_IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))

_URL = (
    "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history"
    "?symbol={scId}&resolution=15&from={from_ts}&to={to_ts}&countback={countback}&currencyCode=INR"
)

# Yahoo's public chart API needs no crumb/cookie handshake for this endpoint (unlike the
# batch /v7/finance/quote endpoint liveStockData.ts uses) -- verified live 2026-07-26 with
# a plain GET + User-Agent. period1/period2 strictly bound the returned window (no countback
# equivalent), so the caller widens it independently of MC's countback (see _yahoo_window()).
_YAHOO_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}.NS"
    "?interval=15m&period1={period1}&period2={period2}"
)

_SELECT_SYMBOLS = """
    SELECT DISTINCT symbol
    FROM nse_stocks
    WHERE symbol IS NOT NULL AND symbol != ''
"""
_SELECT_SYMBOLS_FILTER = """
    SELECT symbol
    FROM nse_stocks
    WHERE symbol IS NOT NULL AND symbol != ''
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

def _fetch_live(symbol: str, from_ts: int, to_ts: int, countback: int = 500) -> Optional[dict]:
    url = _URL.format(scId=symbol, from_ts=from_ts, to_ts=to_ts, countback=countback)
    try:
        resp = _http_get(url)
        data = resp.json()
        if data and data.get("t"):
            return data
    except Exception:
        pass
    return None


def _yahoo_window(to_ts: int, lookback_days: int) -> int:
    """period1 for the Yahoo request -- widened past the literal lookback_days (unlike MC's
    countback, Yahoo has no "reach back further than the window" override) so illiquid names
    that haven't traded in a day or two are still found. Capped at 60d (Yahoo's practical
    history limit for 15m bars)."""
    days = min(60, max(5, lookback_days * 2 + 3))
    return to_ts - days * 24 * 3600


def _fetch_yahoo(symbol: str, from_ts: int, to_ts: int, countback: int = 500) -> Optional[dict]:
    """countback is accepted-but-unused -- kept so this has the same call signature as
    _fetch_live for the dual-source dispatch in run(). Reshapes Yahoo's chart payload into
    the same {"t","o","h","l","c","v"} shape MC returns so parse_bars() stays source-agnostic."""
    period1 = _yahoo_window(to_ts, max(1, (to_ts - from_ts) // 86400))
    url = _YAHOO_URL.format(symbol=symbol, period1=period1, period2=to_ts)
    try:
        resp = _get_session().get(url, timeout=10)
        result = resp.json().get("chart", {}).get("result")
        if not result:
            return None
        r0 = result[0]
        ts = r0.get("timestamp")
        if not ts:
            return None
        quote = r0["indicators"]["quote"][0]
        return {
            "t": ts,
            "o": quote.get("open", []),
            "h": quote.get("high", []),
            "l": quote.get("low", []),
            "c": quote.get("close", []),
            "v": quote.get("volume", []),
        }
    except Exception:
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
    failed = 0
    from_source = {"mc": 0, "yahoo": 0}

    def _write(symbol, data, source=None):
        nonlocal total, failed
        bars = parse_bars(data, symbol)
        if bars:
            executemany(
                _UPSERT,
                [(b["symbol"], b["datetime"], b["open"], b["high"],
                  b["low"], b["close"], b["volume"], b["interval"]) for b in bars],
            )
            total += len(bars)
            if source:
                from_source[source] += 1
        else:
            failed += 1

    def _fetch_dual(symbol, idx, countback):
        """Alternate which source is primary per symbol so load splits ~evenly across
        both, and fall back to the other source on a miss -- MC and Yahoo don't agree on
        which illiquid names have recent data (verified live: MC had zero data for
        ABANSENT, Yahoo had 157 bars), so the fallback also recovers real coverage."""
        if idx % 2 == 0:
            data = _fetch_live(symbol, from_ts, to_ts, countback)
            if data:
                return data, "mc"
            data = _fetch_yahoo(symbol, from_ts, to_ts, countback)
            return (data, "yahoo") if data else (None, None)
        else:
            data = _fetch_yahoo(symbol, from_ts, to_ts, countback)
            if data:
                return data, "yahoo"
            data = _fetch_live(symbol, from_ts, to_ts, countback)
            return (data, "mc") if data else (None, None)

    if use_live:
        # Fetch is I/O-bound (network round-trip dominates) -- sequential fetching of the
        # full ~2400-symbol universe took ~10min and blew the 600s job timeout on every
        # single run once the raw-symbol fix (above) made most requests actually succeed
        # instead of failing instantly. Parallelizing the fetch alone (12 workers, same
        # concurrency mc_ohlcv_backfill.py already validated safe against this exact MC
        # endpoint) wasn't enough on its own -- measured 22.7min for the full universe --
        # because the URL used to hardcode countback=500 regardless of lookback_days, so
        # every routine 15-min top-up cycle was pulling ~20 trading days of bars per symbol
        # (1.14M bars for a 1-day lookback run) instead of just the handful of new bars it
        # actually needed. countback now scales with lookback_days (~25 bars/trading day at
        # 15m resolution, +buffer) so the routine cycle's payload shrinks ~10x while a real
        # deep backfill (--lookback-days 30+) still requests proportionally more than the
        # old fixed 500. Raising worker concurrency alone to push MC further (12->24) started
        # producing a burst of empty responses (measured live) -- MC tolerates ~12 concurrent
        # (matching mc_ohlcv_backfill.py's validated ceiling), not more. Splitting the
        # universe across MC and Yahoo Finance (_fetch_dual above) halves each source's real
        # load instead of pushing one source past its safe concurrency. DB writes stay
        # single-threaded in the main thread as results complete.
        countback = min(5000, max(50, lookback_days * 30 + 20))
        with ThreadPoolExecutor(max_workers=12) as ex:
            futs = {
                ex.submit(_fetch_dual, row["symbol"], i, countback): row["symbol"]
                for i, row in enumerate(rows)
            }
            for f in as_completed(futs):
                symbol = futs[f]
                try:
                    data, source = f.result()
                except Exception:
                    data, source = None, None
                _write(symbol, data, source)
    else:
        for row in rows:
            symbol = row["symbol"]
            data = fetch(symbol, from_ts, to_ts)
            _write(symbol, data)

    # Surface partial failure explicitly -- an aggregate "N bars upserted for M symbols"
    # line reads as full success even when a large fraction silently returned no data
    # (exactly how the mcsymbol/raw-symbol bug above went unnoticed for weeks).
    source_note = f" [mc={from_source['mc']} yahoo={from_source['yahoo']}]" if use_live else ""
    print(f"[INTRADAY] {total} bars upserted; {len(rows) - failed}/{len(rows)} symbols "
          f"returned data ({failed} empty/failed) (lookback={lookback_days}d).{source_note}")
    return total


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Intraday OHLCV fetcher (MC TechCharts 15m)")
    parser.add_argument("--lookback-days", type=int, default=5, help="Days of history to fetch (default 5)")
    parser.add_argument("--symbols", nargs="*", help="NSE symbols to fetch (default: all with mcsymbol)")
    args = parser.parse_args()
    run(lookback_days=args.lookback_days, symbols=args.symbols)
