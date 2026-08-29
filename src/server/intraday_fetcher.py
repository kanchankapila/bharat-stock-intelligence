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
import polars as pl

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class IntradayFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class IntradayFetcherBaseFetcher(BaseFetcher[IntradayFetcherSchema]):
    fetcher_name = 'IntradayFetcher'
    domain = 'niftytrader.in'
    schema = IntradayFetcherSchema
    min_interval_sec = 0.5


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
# Indices are quoted under a caret ticker with no exchange suffix (^NSEI, not NIFTY50.NS).
_YAHOO_INDEX_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    "?interval=15m&period1={period1}&period2={period2}"
)

# Index 15m bars, keyed by the symbol they are stored under in intraday_ohlcv. Without these
# there is no intraday relative-strength-vs-index and no intraday beta hedge -- which is the
# standard way to turn a small directional signal into a tradeable market-neutral one, and was
# flagged as a blocking data gap by the 2026-07-31 intraday audit (only NIFTYBEES, the ETF,
# had any intraday history at all). MoneyControl's TechCharts stock endpoint does not serve
# indices under any of NIFTY / "NIFTY 50" / ^NSEI (probed live, all return no data), so these
# come from Yahoo only, which needs the raw caret ticker with no ".NS" suffix.
_INDEX_SYMBOLS = {
    "NIFTY50":     "^NSEI",
    "NIFTYBANK":   "^NSEBANK",
    "NIFTYIT":     "^CNXIT",
    "NIFTYMIDCAP": "^NSMIDCP",
    "INDIAVIX":    "^INDIAVIX",
}

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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, datetime, interval) DO UPDATE SET
        open   = excluded.open,
        high   = excluded.high,
        low    = excluded.low,
        close  = excluded.close,
        volume = excluded.volume,
        vwap   = excluded.vwap
"""

# Minutes per bar, keyed by the `interval` label written to intraday_ohlcv. Used to reject
# off-grid bars (see _is_on_grid).
_INTERVAL_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60}

# NSE continuous session opens 09:15 IST. Used to decide whether a payload covers a full
# session (and therefore whether its VWAP accumulation is trustworthy) -- see parse_bars.
_SESSION_OPEN_IST = (9, 15)


def _parse_db_dt(value) -> Optional[datetime.datetime]:
    """Normalise an intraday_ohlcv.datetime value (a tz-aware datetime from Postgres, or an
    ISO-ish string on the SQLite dev fallback) to an aware IST datetime. Mirrors parse_bars'
    own epoch->IST conversion, applied to a value read back from the DB instead of a vendor
    payload. Returns None rather than raising on anything unparseable."""
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        dt = value
    else:
        s = str(value).strip().replace(" ", "T")
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.datetime.fromisoformat(s)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(_IST)


def _known_open_days(from_ts: int, symbols: Optional[list] = None) -> dict:
    """{symbol: {date, ...}} for every symbol already carrying a real <=09:15 IST bar in
    intraday_ohlcv within the current fetch window -- see parse_bars' known_open_days param
    for why this matters. One batch query for the whole run rather than per-symbol.
    `symbols` narrows the scan to a manual/scoped run, matching _SELECT_SYMBOLS_FILTER."""
    lower = datetime.datetime.fromtimestamp(from_ts, tz=_IST).isoformat()
    try:
        if symbols:
            ph = ",".join(["?"] * len(symbols))
            rows = query_all(
                f"SELECT symbol, datetime FROM intraday_ohlcv "
                f"WHERE interval = '15m' AND datetime >= ? AND symbol IN ({ph})",
                (lower, *symbols),
            )
        else:
            rows = query_all(
                "SELECT symbol, datetime FROM intraday_ohlcv "
                "WHERE interval = '15m' AND datetime >= ?", (lower,)
            )
    except Exception:
        return {}
    out: dict = {}
    for r in rows:
        dt = _parse_db_dt(r["datetime"])
        if dt is None or (dt.hour, dt.minute) > _SESSION_OPEN_IST:
            continue
        out.setdefault(r["symbol"], set()).add(dt.date())
    return out


def _is_on_grid(dt: datetime.datetime, interval: str) -> bool:
    """True if `dt` is a legitimate start-of-bar timestamp for `interval`.

    Both vendors append the *current in-progress* quote to the history array, stamped at
    request time rather than on the bar grid -- e.g. a real 09:30:00 bar plus a bogus
    09:30:20 one with volume=0 and open==high==low==close. Written verbatim, those synthetic
    rows accounted for 5.5% of all July rows (99.3% of them zero-volume) and roughly one junk
    row per real bar for names fetched successfully every cycle (RELIANCE: 49 rows for a
    25-bar session on 2026-07-30). They are not bars and carry no information -- the real bar
    for the same slot arrives on the next cycle -- but because intraday_features.py selected
    bars *positionally* they silently shortened its "first 30 minutes"/"first hour" windows
    (stored first_hour_vol_share correlated only 0.642 with the correct value).
    """
    step = _INTERVAL_MINUTES.get(interval)
    if not step:
        return True  # unknown interval -- don't silently discard data
    return dt.second == 0 and dt.microsecond == 0 and dt.minute % step == 0


# ── Pure parsing (no I/O) ──────────────────────────────────────────────────────

def parse_bars(data: Optional[dict], symbol: str, interval: str = "15m",
               known_open_days: Optional[set] = None) -> list:
    """Convert a MC TechCharts / Yahoo chart JSON payload into a list of bar dicts.

    Drops off-grid synthetic quotes (see _is_on_grid) and stamps each bar with the running
    session VWAP -- cumulative sum(typical_price * volume) / sum(volume) over that symbol's
    bars so far *within the same IST session*, the standard intraday VWAP definition. The
    column was previously written as a literal NULL for every row, which made
    intraday_features.py's vwap_deviation_pct a constant 0.0 for every symbol on every day
    while still looking populated to any coverage check.

    known_open_days: dates (this symbol) already known to have a real 09:15 bar recorded in
    intraday_ohlcv from an EARLIER fetch cycle, passed in by run(). Without this, a later
    cycle whose own payload happens not to include the open bar for an illiquid name (found
    live 2026-08-09: ~16% of a session's bars sat NULL despite the DB already holding a real
    09:15 bar for those same symbols, written by an earlier cycle) would silently overwrite a
    correctly-computed VWAP with NULL on ON CONFLICT DO UPDATE -- this only ever WIDENS which
    days are trusted, never invents an open that was never actually observed.

    Returns [] for missing/empty data — never raises."""
    if not data or not data.get("t"):
        return []
    t_arr = data.get("t", [])
    o_arr = data.get("o", [])
    h_arr = data.get("h", [])
    l_arr = data.get("l", [])
    c_arr = data.get("c", [])
    v_arr = data.get("v", [])

    def _at(arr, i):
        return arr[i] if i < len(arr) and arr[i] is not None else None

    raw = []
    for i in range(len(t_arr)):
        dt = datetime.datetime.fromtimestamp(t_arr[i], tz=_IST)
        if not _is_on_grid(dt, interval):
            continue
        o, h, l, c = (_at(o_arr, i), _at(h_arr, i), _at(l_arr, i), _at(c_arr, i))
        v = _at(v_arr, i)
        raw.append({
            "symbol":   symbol,
            "dt":       dt,
            "datetime": dt.strftime("%Y-%m-%dT%H:%M:%S+05:30"),
            "open":     float(o) if o is not None else None,
            "high":     float(h) if h is not None else None,
            "low":      float(l) if l is not None else None,
            "close":    float(c) if c is not None else None,
            "volume":   int(v)   if v is not None else None,
            "interval": interval,
        })

    # Session VWAP must accumulate in chronological order and reset each day. The vendor
    # arrays are normally already sorted, but sorting explicitly makes the accumulation
    # correct regardless of payload ordering.
    raw.sort(key=lambda b: b["dt"])
    # A fetch window that opens mid-session (the earliest day of any lookback window is
    # partial) would accumulate VWAP from an arbitrary bar rather than the session open,
    # producing a confidently wrong number -- and the upsert would overwrite a previously
    # correct value with it. Only emit VWAP for days whose session-open bar is present;
    # otherwise leave NULL. An honest NULL is recoverable, a wrong VWAP is not.
    days_with_open = {b["dt"].date() for b in raw
                      if (b["dt"].hour, b["dt"].minute) <= _SESSION_OPEN_IST}
    if known_open_days:
        days_with_open |= known_open_days
    cum_pv, cum_v, cur_day = 0.0, 0.0, None
    for b in raw:
        day = b["dt"].date()
        if day != cur_day:
            cum_pv, cum_v, cur_day = 0.0, 0.0, day
        h, l, c, v = b["high"], b["low"], b["close"], b["volume"]
        if None not in (h, l, c) and v:
            cum_pv += ((h + l + c) / 3.0) * v
            cum_v  += v
        b["vwap"] = (round(cum_pv / cum_v, 4)
                     if cum_v > 0 and day in days_with_open else None)
        del b["dt"]
    return raw


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


def _fetch_yahoo(symbol: str, from_ts: int, to_ts: int, countback: int = 500,
                 yahoo_symbol: Optional[str] = None) -> Optional[dict]:
    """countback is accepted-but-unused -- kept so this has the same call signature as
    _fetch_live for the dual-source dispatch in run(). Reshapes Yahoo's chart payload into
    the same {"t","o","h","l","c","v"} shape MC returns so parse_bars() stays source-agnostic.

    yahoo_symbol overrides the default `{symbol}.NS` construction -- indices are quoted under
    a caret ticker (^NSEI) with no exchange suffix."""
    period1 = _yahoo_window(to_ts, max(1, (to_ts - from_ts) // 86400))
    url = (_YAHOO_INDEX_URL.format(symbol=yahoo_symbol, period1=period1, period2=to_ts)
           if yahoo_symbol else
           _YAHOO_URL.format(symbol=symbol, period1=period1, period2=to_ts))
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

    # Queried once up front, not per-symbol -- see parse_bars' known_open_days param.
    known_open = _known_open_days(from_ts, symbols)

    total = 0
    failed = 0
    from_source = {"mc": 0, "yahoo": 0}

    def _write(symbol, data, source=None):
        nonlocal total, failed
        bars = parse_bars(data, symbol, known_open_days=known_open.get(symbol))
        if bars:
            executemany(
                _UPSERT,
                [(b["symbol"], b["datetime"], b["open"], b["high"],
                  b["low"], b["close"], b["volume"], b["vwap"], b["interval"]) for b in bars],
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

    # Index bars (Yahoo only -- MC's stock endpoint does not serve indices). Fetched even when
    # `symbols` is set, unless the caller explicitly filtered to specific names, so the index
    # series a relative-strength or beta calculation needs is never missing just because a
    # stock-level run was scoped down.
    idx_ok = 0
    if use_live and not symbols:
        for internal, yahoo_sym in _INDEX_SYMBOLS.items():
            try:
                data = _fetch_yahoo(internal, from_ts, to_ts, yahoo_symbol=yahoo_sym)
            except Exception:
                data = None
            bars = parse_bars(data, internal, known_open_days=known_open.get(internal))
            if bars:
                executemany(
                    _UPSERT,
                    [(b["symbol"], b["datetime"], b["open"], b["high"], b["low"],
                      b["close"], b["volume"], b["vwap"], b["interval"]) for b in bars],
                )
                total += len(bars)
                idx_ok += 1

    # Surface partial failure explicitly -- an aggregate "N bars upserted for M symbols"
    # line reads as full success even when a large fraction silently returned no data
    # (exactly how the mcsymbol/raw-symbol bug above went unnoticed for weeks).
    source_note = f" [mc={from_source['mc']} yahoo={from_source['yahoo']}]" if use_live else ""
    idx_note = f" [indices {idx_ok}/{len(_INDEX_SYMBOLS)}]" if use_live and not symbols else ""
    print(f"[INTRADAY] {total} bars upserted; {len(rows) - failed}/{len(rows)} symbols "
          f"returned data ({failed} empty/failed) (lookback={lookback_days}d).{source_note}{idx_note}")
    return total


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Intraday OHLCV fetcher (MC TechCharts 15m)")
    parser.add_argument("--lookback-days", type=int, default=5, help="Days of history to fetch (default 5)")
    parser.add_argument("--symbols", nargs="*", help="NSE symbols to fetch (default: all with mcsymbol)")
    args = parser.parse_args()
    run(lookback_days=args.lookback_days, symbols=args.symbols)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
