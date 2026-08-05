"""
nt_pcr_ts_fetcher.py
=====================
Fetches intraday Put/Call Ratio time series from NiftyTrader for major indices
and stores minute-level data in nt_index_pcr_ts.

API: https://webapi.niftytrader.in/webapi/option/oi-pcr-data
     ?symbolName={nt_symbol}&reqType=nse_pcr_data&reqDate=

Index symbols are read from index_provider_map (provider='nt_index').
Fallback: NIFTY50→nifty, NIFTYBANK→banknifty, NIFTYFINSRV→finnifty, NIFTYMIDSELECT→midcpnifty

Data written to nt_index_pcr_ts:
  index_name, ts (datetime), expiry, pcr, volume_pcr, change_oi_pcr, index_close

Run:
  python nt_pcr_ts_fetcher.py                    # all mapped indices
  python nt_pcr_ts_fetcher.py --index NIFTYBANK  # single index
  python nt_pcr_ts_fetcher.py --date 2026-06-27  # historical date (if API supports)
"""

import argparse
from datetime import date as _date
from urllib.parse import urlencode

import requests

from db_compat import connect, executemany, load_index_map_inv, query_all, translate
from fetch_utils import retry_get

NT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
}

PCR_BASE_URL = "https://webapi.niftytrader.in/webapi/option/oi-pcr-data"

# provider → reqType used in PCR API
_REQ_TYPE = {
    "nt_index":     "nse_pcr_data",
    "nt_index_bse": "bse_pcr_data",
}

_FALLBACK: dict[str, tuple[str, str]] = {
    "NIFTY50":        ("nifty",      "nse_pcr_data"),
    "NIFTYBANK":      ("banknifty",  "nse_pcr_data"),
    "NIFTYFINSRV":    ("finnifty",   "nse_pcr_data"),
    "NIFTYMIDSELECT": ("midcpnifty", "nse_pcr_data"),
    "SENSEX":         ("sensex",     "bse_pcr_data"),
    "BANKEX":         ("bankex",     "bse_pcr_data"),
}


def _get_nt_index_map() -> dict[str, tuple[str, str]]:
    """Return {index_name: (nt_api_symbol, req_type)} from DB."""
    result: dict[str, tuple[str, str]] = {}
    try:
        for provider, req_type in _REQ_TYPE.items():
            rows = query_all(
                "SELECT index_name, provider_id FROM index_provider_map WHERE provider = ?",
                (provider,)
            )
            for r in rows:
                result[r["index_name"]] = (r["provider_id"], req_type)
    except Exception as e:
        print(f"[nt_pcr_ts] WARN: index map lookup failed ({e}), using fallback")
    return result or _FALLBACK


def _sf(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _candidate_pcr_urls(nt_symbol: str, req_type: str, req_date: str = "") -> list[str]:
    """Build ordered request candidates for NiftyTrader PCR endpoint.

    Why this exists: live probes have shown 400s for some query-shape combinations
    (notably around symbol param naming and blank reqDate handling). Keep the canonical
    shape first, then fall back to compatible variants.
    """
    symbol = (nt_symbol or "").strip()
    if not symbol:
        return []

    req_date = (req_date or "").strip()
    symbol_variants = [symbol]
    lower = symbol.lower()
    if lower not in symbol_variants:
        symbol_variants.append(lower)

    urls: list[str] = []
    seen: set[str] = set()

    def add_url(params: dict[str, str]) -> None:
        q = urlencode(params)
        url = f"{PCR_BASE_URL}?{q}"
        if url not in seen:
            seen.add(url)
            urls.append(url)

    # Primary/canonical form (seen in captured live URLs).
    for sym in symbol_variants:
        params = {"symbolName": sym, "reqType": req_type}
        if req_date:
            params["reqDate"] = req_date
        add_url(params)

    # Alternate symbol key, seen on sibling NT option endpoints.
    for sym in symbol_variants:
        params = {"symbol": sym, "reqType": req_type}
        if req_date:
            params["reqDate"] = req_date
        add_url(params)

    # Legacy blank reqDate variant (keep last; some older captures include this shape).
    if not req_date:
        for key in ("symbolName", "symbol"):
            add_url({key: lower, "reqType": req_type, "reqDate": ""})

    return urls


def fetch_pcr(nt_symbol: str, req_type: str, req_date: str = "") -> tuple[list[str], list[dict]]:
    """Fetch PCR time series. Returns (expiry_dates, oiDatas)."""
    urls = _candidate_pcr_urls(nt_symbol, req_type, req_date)
    if not urls:
        return [], []

    last_err: Exception | None = None
    last_api_msg: str | None = None

    for url in urls:
        try:
            r = retry_get(requests, url, headers=NT_HEADERS, timeout=20)
            d = r.json()
            if d.get("result") != 1:
                last_api_msg = str(d.get("resultMessage") or "unknown")
                continue
            rd = d.get("resultData") or {}
            expiries = rd.get("oiExpiryDates") or []
            data = rd.get("oiDatas") or []
            return expiries, data
        except Exception as e:
            last_err = e
            continue

    if last_api_msg:
        print(f"  [PCR] API error for {nt_symbol}: {last_api_msg}")
    elif last_err:
        print(f"  [PCR] fetch error for {nt_symbol} after retries: {last_err}")
    return [], []


def save_pcr_ts(index_name: str, data: list[dict]) -> int:
    """Upsert PCR time series rows into nt_index_pcr_ts. Returns count saved."""
    if not data:
        return 0

    rows = []
    for rec in data:
        ts      = str(rec.get("time") or "")[:19]
        expiry  = str(rec.get("expiry_date") or "")[:10]
        if not ts or not expiry:
            continue
        rows.append((
            index_name,
            ts,
            expiry,
            _sf(rec.get("pcr")),
            _sf(rec.get("volume_pcr")),
            _sf(rec.get("change_oi_pcr")),
            _sf(rec.get("index_close")),
        ))

    if not rows:
        return 0

    executemany("""
        INSERT INTO nt_index_pcr_ts
            (index_name, ts, expiry, pcr, volume_pcr, change_oi_pcr, index_close)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (index_name, ts, expiry) DO UPDATE SET
            pcr           = excluded.pcr,
            volume_pcr    = excluded.volume_pcr,
            change_oi_pcr = excluded.change_oi_pcr,
            index_close   = excluded.index_close,
            fetched_at    = CURRENT_TIMESTAMP
    """, rows)
    return len(rows)


def run(target_index: str | None = None, req_date: str = "") -> None:
    nt_map = _get_nt_index_map()
    if target_index:
        nt_map = {k: v for k, v in nt_map.items() if k == target_index.upper()}
        if not nt_map:
            all_known = _get_nt_index_map()
            print(f"[nt_pcr_ts] Unknown index {target_index!r}. Known: {list(all_known)}")
            return

    print(f"[nt_pcr_ts] Fetching PCR time series for {list(nt_map)} ...")
    total = 0
    for index_name, (nt_symbol, req_type) in nt_map.items():
        print(f"  {index_name} ({nt_symbol}/{req_type}) ...", end=" ", flush=True)
        expiries, data = fetch_pcr(nt_symbol, req_type, req_date)
        n = save_pcr_ts(index_name, data)
        print(f"{n} rows  (expiries: {[e[:10] for e in expiries[:3]]})")
        total += n

    print(f"[nt_pcr_ts] Done. {total} rows saved.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", default=None, help="Single index, e.g. NIFTYBANK")
    parser.add_argument("--date",  default="",   help="reqDate param (leave empty for today)")
    args = parser.parse_args()
    run(target_index=args.index, req_date=args.date)
