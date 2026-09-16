"""
nt_change_oi_fetcher.py
========================
Fetches per-strike OI *change* (buildup / unwinding) for major indices from
NiftyTrader and stores it in nt_index_change_oi.

Complements nt_oi_snapshot_fetcher.py (absolute OI) — this shows where new
money is flowing in vs flowing out, which is the primary indicator for
support/resistance confirmation.

API: https://www.niftytrader.in/api/niftytrader/Option/change-oi-time-range
     ?symbol={nt_symbol}&start_time={time}&end_time={time}&expiry=&exchange={exchange}

Runs for all indices in index_provider_map (provider nt_index + nt_index_bse).

Run:
  python nt_change_oi_fetcher.py                    # all indices, EOD snapshot
  python nt_change_oi_fetcher.py --index NIFTYBANK  # single index
  python nt_change_oi_fetcher.py --time 14:00:00    # intraday snapshot
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class NtChangeOiFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class NtChangeOiFetcherBaseFetcher(BaseFetcher[NtChangeOiFetcherSchema]):
    fetcher_name = 'NtChangeOiFetcher'
    domain = 'niftytrader.in'
    schema = NtChangeOiFetcherSchema
    min_interval_sec = 0.5


import argparse
from datetime import date as _date

import requests

from db_compat import execute, executemany, query_all
from fetch_utils import retry_get
import sys

NT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
}

CHANGE_OI_URL = (
    "https://www.niftytrader.in/api/niftytrader/Option/change-oi-time-range"
    "?symbol={symbol}&start_time={time}&end_time={time}&expiry=&exchange={exchange}"
)

_EXCHANGE = {"nt_index": "nse", "nt_index_bse": "bse"}

_FALLBACK: dict[str, tuple[str, str]] = {
    "NIFTY50":        ("nifty",      "nse"),
    "NIFTYBANK":      ("banknifty",  "nse"),
    "NIFTYFINSRV":    ("finnifty",   "nse"),
    "NIFTYMIDSELECT": ("midcpnifty", "nse"),
    "SENSEX":         ("sensex",     "bse"),
    "BANKEX":         ("bankex",     "bse"),
}


def _get_nt_index_map() -> dict[str, tuple[str, str]]:
    result: dict[str, tuple[str, str]] = {}
    try:
        for provider, exchange in _EXCHANGE.items():
            rows = query_all(
                "SELECT index_name, provider_id FROM index_provider_map WHERE provider = ?",
                (provider,)
            )
            for r in rows:
                result[r["index_name"]] = (r["provider_id"], exchange)
    except Exception as e:
        print(f"[nt_chg_oi] WARN: index map lookup failed ({e}), using fallback", file=sys.stderr)
    return result or _FALLBACK


def _sf(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def fetch_change_oi(nt_symbol: str, snap_time: str, exchange: str) -> list[dict]:
    url = CHANGE_OI_URL.format(symbol=nt_symbol, time=snap_time, exchange=exchange)
    try:
        r = retry_get(requests, url, headers=NT_HEADERS, timeout=20)
        d = r.json()
        if d.get("result") != 1:
            print(f"  [chg-OI] API error for {nt_symbol}: {d.get('resultMessage')}")
            return []
        return d.get("resultData") or []
    except Exception as e:
        print(f"  [chg-OI] fetch error for {nt_symbol} after retries: {e}", file=sys.stderr)
        return []


def save_change_oi(index_name: str, data: list[dict], today: str) -> int:
    if not data:
        return 0

    rows = []
    for rec in data:
        strike   = _sf(rec.get("strike_price"))
        expiry   = str(rec.get("expiry_date") or "")[:10]
        snap_ts  = str(rec.get("time") or "")[:19]
        if strike is None or not expiry:
            continue
        rows.append((
            index_name, today, expiry, strike, snap_ts,
            _sf(rec.get("index_close")),
            _sf(rec.get("calls_change_oi")),     _sf(rec.get("calls_change_oi_value")),
            _sf(rec.get("puts_change_oi")),      _sf(rec.get("puts_change_oi_value")),
        ))

    if not rows:
        return 0

    executemany("""
        INSERT INTO nt_index_change_oi
            (index_name, date, expiry, strike, snap_time, index_close,
             calls_change_oi, calls_change_oi_val, puts_change_oi, puts_change_oi_val)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (index_name, date, expiry, strike) DO UPDATE SET
            snap_time           = excluded.snap_time,
            index_close         = excluded.index_close,
            calls_change_oi     = excluded.calls_change_oi,
            calls_change_oi_val = excluded.calls_change_oi_val,
            puts_change_oi      = excluded.puts_change_oi,
            puts_change_oi_val  = excluded.puts_change_oi_val,
            fetched_at          = CURRENT_TIMESTAMP
    """, rows)
    return len(rows)


def run(target_index: str | None = None, snap_time: str = "15:20:00") -> None:
    nt_map = _get_nt_index_map()
    if target_index:
        nt_map = {k: v for k, v in nt_map.items() if k == target_index.upper()}
        if not nt_map:
            print(f"[nt_chg_oi] Unknown index {target_index!r}. Known: {list(_get_nt_index_map())}")
            return

    today = _date.today().isoformat()
    print(f"[nt_chg_oi] Fetching OI change snapshot @{snap_time} for {list(nt_map)} ...")
    total = 0
    for index_name, (nt_symbol, exchange) in nt_map.items():
        print(f"  {index_name} ({nt_symbol}/{exchange}) ...", end=" ", flush=True)
        data = fetch_change_oi(nt_symbol, snap_time, exchange)
        n = save_change_oi(index_name, data, today)
        print(f"{n} strike rows")
        total += n

    print(f"[nt_chg_oi] Done. {total} rows saved.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", default=None,     help="e.g. NIFTYBANK")
    parser.add_argument("--time",  default="15:20:00", help="Snapshot time HH:MM:SS")
    args = parser.parse_args()
    run(target_index=args.index, snap_time=args.time)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
