"""
nt_oi_snapshot_fetcher.py
==========================
Fetches a strike-wise option OI snapshot for major indices from NiftyTrader
and stores it in nt_index_oi_eod (one row per strike per expiry, EOD snapshot).

API: https://www.niftytrader.in/api/niftytrader/Option/oi-time-range
     ?symbol={nt_symbol}&start_time={start}&end_time={end}&expiry=&exchange=nse

Index symbols are read from index_provider_map (provider='nt_index').
Fetches the 15:20:00 snapshot (last OI before close).

Data written to nt_index_oi_eod:
  index_name, date, expiry, strike, snap_time, index_close,
  calls_oi, puts_oi, calls_change_oi, puts_change_oi,
  calls_volume, puts_volume, calls_oi_value, puts_oi_value

Also derives and upserts into index_max_pain:
  max pain strike, total CE/PE OI, PCR

Run:
  python nt_oi_snapshot_fetcher.py                    # all indices, EOD snapshot
  python nt_oi_snapshot_fetcher.py --index NIFTYBANK  # single index
  python nt_oi_snapshot_fetcher.py --time 14:00:00    # intraday snapshot
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class NtOiSnapshotFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class NtOiSnapshotFetcherBaseFetcher(BaseFetcher[NtOiSnapshotFetcherSchema]):
    fetcher_name = 'NtOiSnapshotFetcher'
    domain = 'niftytrader.in'
    schema = NtOiSnapshotFetcherSchema
    min_interval_sec = 0.5


import argparse
import requests

from as_of import logical_trading_date
from db_compat import execute, executemany, query_all
from fetch_utils import retry_get
import sys

SOURCE = "niftytrader"

NT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
}

OI_URL = (
    "https://www.niftytrader.in/api/niftytrader/Option/oi-time-range"
    "?symbol={symbol}&start_time={time}&end_time={time}&expiry=&exchange={exchange}"
)

# provider → exchange param for OI URL
_EXCHANGE = {
    "nt_index":     "nse",
    "nt_index_bse": "bse",
}

_FALLBACK: dict[str, tuple[str, str]] = {
    "NIFTY50":        ("nifty",      "nse"),
    "NIFTYBANK":      ("banknifty",  "nse"),
    "NIFTYFINSRV":    ("finnifty",   "nse"),
    "NIFTYMIDSELECT": ("midcpnifty", "nse"),
    "SENSEX":         ("sensex",     "bse"),
    "BANKEX":         ("bankex",     "bse"),
}


def _get_nt_index_map() -> dict[str, tuple[str, str]]:
    """Return {index_name: (nt_api_symbol, exchange)} from DB."""
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
        print(f"[nt_oi_snap] WARN: index map lookup failed ({e}), using fallback", file=sys.stderr)
    return result or _FALLBACK


def _sf(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def fetch_oi_snapshot(nt_symbol: str, snap_time: str, exchange: str = "nse") -> list[dict]:
    url = OI_URL.format(symbol=nt_symbol, time=snap_time, exchange=exchange)
    try:
        r = retry_get(requests, url, headers=NT_HEADERS, timeout=20)
        d = r.json()
        if d.get("result") != 1:
            print(f"  [OI] API error for {nt_symbol}: {d.get('resultMessage')}")
            return []
        return d.get("resultData") or []
    except Exception as e:
        print(f"  [OI] fetch error for {nt_symbol} after retries: {e}", file=sys.stderr)
        return []


def _compute_max_pain(rows: list[dict]) -> float | None:
    """Strike minimising total writer payout."""
    strikes = [(r.get("strike_price"), r.get("calls_oi") or 0, r.get("puts_oi") or 0)
               for r in rows if r.get("strike_price") is not None]
    if not strikes:
        return None
    best_strike, min_pain = None, float("inf")
    for sp, _, _ in strikes:
        pain = sum(
            (co * (sp - s) if sp > s else 0) + (po * (s - sp) if sp < s else 0)
            for s, co, po in strikes
        )
        if pain < min_pain:
            min_pain, best_strike = pain, sp
    return best_strike


def save_snapshot(index_name: str, data: list[dict], today: str) -> int:
    if not data:
        return 0

    rows = []
    for rec in data:
        strike    = _sf(rec.get("strike_price"))
        expiry    = str(rec.get("expiry_date") or "")[:10]
        snap_ts   = str(rec.get("time") or "")[:19]
        if strike is None or not expiry:
            continue
        rows.append((
            index_name, today, expiry, strike, snap_ts,
            _sf(rec.get("index_close")),
            _sf(rec.get("calls_oi")),        _sf(rec.get("puts_oi")),
            _sf(rec.get("calls_change_oi")), _sf(rec.get("puts_change_oi")),
            _sf(rec.get("calls_volume")),    _sf(rec.get("puts_volume")),
            _sf(rec.get("calls_oi_value")),  _sf(rec.get("puts_oi_value")),
        ))

    if not rows:
        return 0

    executemany("""
        INSERT INTO nt_index_oi_eod
            (index_name, date, expiry, strike, snap_time, index_close,
             calls_oi, puts_oi, calls_change_oi, puts_change_oi,
             calls_volume, puts_volume, calls_oi_value, puts_oi_value)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (index_name, date, expiry, strike) DO UPDATE SET
            snap_time       = excluded.snap_time,
            index_close     = excluded.index_close,
            calls_oi        = excluded.calls_oi,
            puts_oi         = excluded.puts_oi,
            calls_change_oi = excluded.calls_change_oi,
            puts_change_oi  = excluded.puts_change_oi,
            calls_volume    = excluded.calls_volume,
            puts_volume     = excluded.puts_volume,
            calls_oi_value  = excluded.calls_oi_value,
            puts_oi_value   = excluded.puts_oi_value,
            fetched_at      = CURRENT_TIMESTAMP
    """, rows)

    # Derive max pain and PCR per expiry and write to index_max_pain
    expiries: dict[str, list[dict]] = {}
    for rec in data:
        exp = str(rec.get("expiry_date") or "")[:10]
        if exp:
            expiries.setdefault(exp, []).append(rec)

    for exp, recs in expiries.items():
        total_ce = sum(_sf(r.get("calls_oi")) or 0 for r in recs)
        total_pe = sum(_sf(r.get("puts_oi"))  or 0 for r in recs)
        pcr = total_pe / total_ce if total_ce > 0 else None
        mp  = _compute_max_pain(recs)
        snap_ts = str(recs[0].get("time") or "")[:19]
        execute("""
            INSERT INTO index_max_pain
                (source, index_name, date, expiry, max_pain, pcr_oi, total_ce_oi, total_pe_oi, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (source, index_name, date, expiry) DO UPDATE SET
                max_pain    = excluded.max_pain,
                pcr_oi      = excluded.pcr_oi,
                total_ce_oi = excluded.total_ce_oi,
                total_pe_oi = excluded.total_pe_oi,
                fetched_at  = excluded.fetched_at
        """, (SOURCE, index_name, today, exp, mp, pcr, int(total_ce), int(total_pe), snap_ts))

    return len(rows)


def run(target_index: str | None = None, snap_time: str = "15:20:00") -> None:
    nt_map = _get_nt_index_map()
    if target_index:
        nt_map = {k: v for k, v in nt_map.items() if k == target_index.upper()}
        if not nt_map:
            all_known = _get_nt_index_map()
            print(f"[nt_oi_snap] Unknown index {target_index!r}. Known: {list(all_known)}")
            return

    today = logical_trading_date()
    print(f"[nt_oi_snap] Fetching EOD OI snapshot @{snap_time} for {list(nt_map)} ...")
    total = 0
    for index_name, (nt_symbol, exchange) in nt_map.items():
        print(f"  {index_name} ({nt_symbol}/{exchange}) ...", end=" ", flush=True)
        data = fetch_oi_snapshot(nt_symbol, snap_time, exchange)
        n = save_snapshot(index_name, data, today)
        print(f"{n} strike rows")
        total += n

    print(f"[nt_oi_snap] Done. {total} rows saved.")


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
