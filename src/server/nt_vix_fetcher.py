"""
nt_vix_fetcher.py
=================
Fetches India VIX and GIFT NIFTY intraday spot data from NiftyTrader.

Sources:
  India VIX  → other-stock-spot-data?symbol=INDIA+VIX
  GIFT NIFTY → other-stock-spot-data?symbol=GIFT+NIFTY

Both store:
  1. macro_asset_prices — daily EOD close (symbol='INDIAVIX' / 'GIFTNIFTY')
  2. nt_index_pcr_ts    — intraday 2-min tick values (pcr column = spot value)

Run:
  python nt_vix_fetcher.py
  python nt_vix_fetcher.py --symbol GIFT+NIFTY
"""

import argparse
from datetime import date as _date

import requests

from db_compat import execute, executemany
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

SPOT_URL = "https://webapi.niftytrader.in/webapi/Symbol/other-stock-spot-data?symbol={symbol}"

# NT URL param → canonical name (for DB storage)
_SYMBOLS: list[tuple[str, str]] = [
    ("INDIA+VIX",  "INDIAVIX"),
    ("GIFT+NIFTY", "GIFTNIFTY"),
]


def _sf(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def fetch_spot(nt_param: str) -> dict | None:
    try:
        r = retry_get(requests, SPOT_URL.format(symbol=nt_param), headers=NT_HEADERS, timeout=15)
        d = r.json()
        if d.get("result") != 1:
            print(f"  [spot] API error for {nt_param}: {d.get('resultMessage')}")
            return None
        return d.get("resultData")
    except Exception as e:
        print(f"  [spot] fetch error for {nt_param} after retries: {e}", file=sys.stderr)
        return None


def save_spot(data: dict, index_name: str) -> None:
    today = _date.today().isoformat()

    close = _sf(data.get("last_trade_price")) or _sf(data.get("close"))
    if close:
        execute("""
            INSERT INTO macro_asset_prices (symbol, date, close, fetched_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (symbol, date) DO UPDATE SET
                close = excluded.close, fetched_at = excluded.fetched_at
        """, (index_name, today, close))
        print(f"  [{index_name}] EOD close={close}  change={data.get('change_per')}%")

    chart_vals  = str(data.get("chart_data") or "").split(",")
    chart_times = str(data.get("chart_time") or "").split(",")

    rows = []
    for t_str, v_str in zip(chart_times, chart_vals):
        t_str, v = t_str.strip(), _sf(v_str.strip())
        if not t_str or v is None:
            continue
        rows.append((index_name, f"{today}T{t_str}", today, v, None, None, None))

    if rows:
        executemany("""
            INSERT INTO nt_index_pcr_ts
                (index_name, ts, expiry, pcr, volume_pcr, change_oi_pcr, index_close)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (index_name, ts, expiry) DO UPDATE SET
                pcr = excluded.pcr, fetched_at = CURRENT_TIMESTAMP
        """, rows)
        print(f"  [{index_name}] {len(rows)} intraday ticks saved.")


def main(target: str | None = None) -> None:
    symbols = _SYMBOLS
    if target:
        symbols = [(p, n) for p, n in _SYMBOLS if p == target or n == target.upper()]
        if not symbols:
            print(f"[nt_vix] Unknown symbol {target!r}. Use one of: {[p for p,_ in _SYMBOLS]}")
            return

    print(f"[nt_vix] Fetching spot data for {[n for _,n in symbols]} ...")
    for nt_param, index_name in symbols:
        data = fetch_spot(nt_param)
        if data:
            save_spot(data, index_name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None, help="NT param, e.g. INDIA+VIX or GIFT+NIFTY")
    args = parser.parse_args()
    main(target=args.symbol)
