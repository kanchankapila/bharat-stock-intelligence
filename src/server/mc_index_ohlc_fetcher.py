"""
MoneyControl Index OHLC Fetcher
================================
Fetches historical daily OHLC for Indian indices from the MoneyControl graph API
and upserts into stock_ohlcv (same table used for stocks).

API endpoint (note: & not ? after the base path — MC's unusual format):
  https://appfeeds.moneycontrol.com/jsonapi/market/graph&format=json&ind_id={ind_id}&range={range}&type=ohlc

Run:  python mc_index_ohlc_fetcher.py            # 2yr range (default)
      python mc_index_ohlc_fetcher.py --full      # max range
      python mc_index_ohlc_fetcher.py --range 6m  # specific range
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class McIndexOhlcFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class McIndexOhlcFetcherBaseFetcher(BaseFetcher[McIndexOhlcFetcherSchema]):
    fetcher_name = 'McIndexOhlcFetcher'
    domain = 'moneycontrol.com'
    schema = McIndexOhlcFetcherSchema
    min_interval_sec = 0.5


import argparse
import datetime
import time

import requests

from db_compat import execute, executemany, query_all
import sys

# ── Index mapping: loaded from DB (index_provider_map provider='mc_ohlc') ─────
# Fallback used only if the table is missing (first-run bootstrap).
_MC_OHLC_FALLBACK = {
    "4": "SENSEX", "9": "NIFTY50", "23": "NIFTYBANK", "19": "NIFTYIT",
    "41": "NIFTYPHARMA", "52": "NIFTYAUTO", "39": "NIFTYFMCG", "51": "NIFTYMETAL",
    "34": "NIFTYREALTY", "35": "NIFTYINFRA", "38": "NIFTYENERGY",
    "27": "NIFTYMIDCAP100", "53": "NIFTYSMALLCAP", "31": "NIFTYMIDCAP50",
    "28": "NIFTY100", "36": "INDIAVIX",
}

def _get_mc_ohlc_map() -> dict[int, str]:
    """Return {ind_id (int): index_name} from DB."""
    from db_compat import load_index_map
    m = load_index_map("mc_ohlc")
    return {int(k): v for k, v in m.items()} if m else {int(k): v for k, v in _MC_OHLC_FALLBACK.items()}

VALID_RANGES = ("1d", "5d", "1m", "3m", "6m", "1yr", "2yr", "5yr", "max")
DEFAULT_RANGE = "2yr"

BASE_URL = (
    "https://appfeeds.moneycontrol.com/jsonapi/market/graph"
    "&format=json&ind_id={ind_id}&range={range}&type=ohlc"
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.moneycontrol.com/",
    "Origin": "https://www.moneycontrol.com",
}

# ── Holiday helpers ────────────────────────────────────────────────────────────

_holiday_cache: set[str] | None = None


def _safe_float(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _load_holidays() -> set[str]:
    global _holiday_cache
    if _holiday_cache is not None:
        return _holiday_cache
    try:
        rows = query_all(
            "SELECT date FROM market_holidays WHERE exchange='NSE'"
        )
        _holiday_cache = {str(r[0])[:10] for r in rows}
    except Exception:
        _holiday_cache = set()
    return _holiday_cache


def _is_holiday(date_str: str) -> bool:
    return date_str in _load_holidays()


# ── Schema ─────────────────────────────────────────────────────────────────────

def ensure_schema() -> None:
    """stock_ohlcv already exists; nothing extra needed for indices."""
    execute(
        """
        CREATE TABLE IF NOT EXISTS stock_ohlcv (
            symbol  TEXT NOT NULL,
            date    TEXT NOT NULL,
            open    REAL,
            high    REAL,
            low     REAL,
            close   REAL,
            volume  REAL,
            PRIMARY KEY (symbol, date)
        )
        """
    )


# ── Fetch ──────────────────────────────────────────────────────────────────────

def fetch_index_ohlc(session: requests.Session, ind_id: int, range_: str) -> list[dict]:
    """Fetch OHLC rows for one index from MoneyControl. Returns list of dicts."""
    url = BASE_URL.format(ind_id=ind_id, range=range_)
    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[MC-OHLC] HTTP error ind_id={ind_id}: {e}", file=sys.stderr)
        return []

    # MC appfeeds graph response: {"graph": {"values": [{"_time": "29 May 2026",
    # "_open": "...", "_high": "...", "_low": "...", "_close": "...", "_volume": "0"}]}}
    graph_block = data.get("graph") or {}
    raw_rows = graph_block.get("values") or data.get("g") or []
    if not raw_rows:
        return []

    rows = []
    for item in raw_rows:
        try:
            if isinstance(item, dict):
                # Dict format: {"_time": "29 May 2026", "_open": "...", ...}
                date_raw = item.get("_time", "")
                open_  = item.get("_open")
                high   = item.get("_high")
                low    = item.get("_low")
                close  = item.get("_close")
                volume = item.get("_volume")
                # Parse "DD Mon YYYY" date
                d = datetime.datetime.strptime(str(date_raw).strip(), "%d %b %Y").date()
                date_str = d.isoformat()
            else:
                # List format: [timestamp_ms, open, high, low, close, volume]
                if len(item) < 5:
                    continue
                ts_ms = item[0]
                open_, high, low, close = item[1], item[2], item[3], item[4]
                volume = item[5] if len(item) > 5 else 0
                date_str = datetime.datetime.utcfromtimestamp(ts_ms / 1000).strftime("%Y-%m-%d")
        except Exception:
            continue

        # Skip known market holidays
        if _is_holiday(date_str):
            continue

        try:
            close_f = float(close) if close is not None else None
            if not close_f:
                continue
        except (TypeError, ValueError):
            continue

        rows.append({
            "date":   date_str,
            "open":   _safe_float(open_),
            "high":   _safe_float(high),
            "low":    _safe_float(low),
            "close":  close_f,
            "volume": _safe_float(volume) or 0.0,
        })

    return rows


# ── Upsert ─────────────────────────────────────────────────────────────────────

def upsert_ohlc(symbol: str, rows: list[dict]) -> int:
    """Upsert OHLC rows for one symbol into stock_ohlcv. Returns count upserted."""
    if not rows:
        return 0

    records = [
        (symbol, r["date"], r["open"], r["high"], r["low"], r["close"], r["volume"])
        for r in rows
    ]

    executemany(
        """
        INSERT INTO stock_ohlcv (symbol, date, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            open   = excluded.open,
            high   = excluded.high,
            low    = excluded.low,
            close  = excluded.close,
            volume = excluded.volume
        """,
        records,
    )
    return len(records)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch MoneyControl index OHLC into stock_ohlcv")
    parser.add_argument(
        "--range",
        dest="range_",
        default=DEFAULT_RANGE,
        choices=VALID_RANGES,
        help=f"Date range to fetch (default: {DEFAULT_RANGE})",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Use 'max' range (overrides --range)",
    )
    parser.add_argument(
        "--indices",
        nargs="*",
        help="Subset of symbols to fetch (e.g. NIFTY50 SENSEX). Fetches all if omitted.",
    )
    args = parser.parse_args()

    range_ = "max" if args.full else args.range_

    ensure_schema()

    # Build the work list
    work = {
        ind_id: symbol
        for ind_id, symbol in _get_mc_ohlc_map().items()
        if args.indices is None or symbol in args.indices
    }

    session = requests.Session()
    session.headers.update(HEADERS)

    total_upserted = 0
    for ind_id, symbol in work.items():
        rows = fetch_index_ohlc(session, ind_id, range_)
        n = upsert_ohlc(symbol, rows)
        print(f"[MC-OHLC] {symbol}: {n} rows upserted")
        total_upserted += n
        time.sleep(0.3)   # gentle rate-limit

    print(f"[MC-OHLC] Done. Total rows upserted: {total_upserted}")


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
