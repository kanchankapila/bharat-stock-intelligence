#!/usr/bin/env python3
"""
Trading80's own buy/sell call list -- entry, target, stop-loss, and a self-reported
"probable success rate" per call.

WHY THIS EXISTS
----------------
Promoted from `endpoint_registry.py`'s `CURATED_EXTRA_ENDPOINTS` (`trading80_call_alerts`,
added 2026-07-30), where it was archived raw into `extra_endpoint_responses` (symbol='MARKET')
and never parsed.

    https://frapi.trading80.com/callsapi/getCallAlerts?w=yes

Live-verified 2026-08-15: returns `data.new` (newly opened calls) and `data.changes` (updates
to calls already open), 10 rows each on a normal day. Rows carry Trading80's own opaque
`stockid` -- the SAME id space as `trading80_header_info`/`marketsmojo_header_info`
(scripts/stocklist.json's shared `stockid` field, per data-sources.md's MarketsMojo-onboarding
note), resolved here the identical way `marketsmojo_technical_fetcher.py`'s `load_sid_map()`
does, just inverted (stockid -> symbol instead of symbol -> stockid).

This is a THIRD-PARTY MODEL'S OWN CALLS, not a measured factor of this platform's -- treat
`prob_success` as a vendor's self-reported claim, not a validated win rate. Do not wire into
scoring without a fresh factor_backtest.py-style measurement of Trading80's own calls against
realized returns (same discipline as `mojo_indigraph` in measurement.md, which measured -0.08
to -0.14%/period for MarketsMojo's own directional call -- a vendor's standing opinion has not
beaten this platform's own null result yet).

ENDPOINT QUIRKS -- verified, do not "fix" these
-----------------------------------------------
* `data.alerts` (a third list, distinct from new/changes) was empty on every sample taken --
  looks like a per-session "stocks you follow" list that's empty for an anonymous/no-cookie
  request. Not fetched; nothing to fetch.
* `new` and `changes` share the same row shape, but only `new` rows carry a real `id` (a
  Trading80-issued hex string) -- every `changes` row's `id` is live-confirmed `null`, on
  every sampled row, not occasionally missing. `id` is namespaced by list here (new/changes)
  since a call can appear in both lists across two different fetches without any guarantee its
  `id` stays stable in either. For `changes`, since there is no real id to key on, the row key
  falls back to `stockid:calltime` (a call updates at most once per labeled `calltime`, so this
  is stable across re-fetches without fabricating an id the provider doesn't supply) -- `new`
  never needs the fallback since it always has a real one.

Run:
  python trading80_call_alerts_fetcher.py
"""

import polars as pl
import json
import sys
from pathlib import Path

import requests

from db_compat import connect, ConnWrapper

API = "https://frapi.trading80.com/callsapi/getCallAlerts?w=yes"
SOURCE = "trading80"
LISTS = ("new", "changes")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.trading80.com/",
}

_STOCKLIST_PATH = Path(__file__).resolve().parents[2] / "scripts" / "stocklist.json"
_sid_to_symbol: dict[str, str] | None = None


def load_sid_to_symbol_map() -> dict[str, str]:
    """stockid -> symbol (uppercase), loaded once from scripts/stocklist.json. Same shared
    `stockid` field marketsmojo_technical_fetcher.py's load_sid_map() uses in the forward
    direction -- inverted here since this endpoint returns stockid, not symbol."""
    global _sid_to_symbol
    if _sid_to_symbol is not None:
        return _sid_to_symbol
    with open(_STOCKLIST_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    _sid_to_symbol = {
        str(row["stockid"]): row["symbol"].upper()
        for row in rows
        if row.get("symbol") and row.get("stockid")
    }
    return _sid_to_symbol


def fetch_call_alerts() -> dict:
    """The ONLY fetch path -- tests call this, never a reimplementation. Returns
    {"new": [...], "changes": [...]}."""
    r = requests.get(API, headers=HEADERS, timeout=20)
    r.raise_for_status()
    payload = r.json()
    if not isinstance(payload, dict):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        raise ValueError(f"unexpected data envelope: {str(data)[:200]}")
    return {name: (data.get(name) or []) for name in LISTS}


def _num(raw: dict, key: str) -> float | None:
    v = raw.get(key)
    if v is None or v == "":
        return None
    try:
        f = float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def parse_call(list_name: str, raw: dict, sid_map: dict) -> dict | None:
    """One API row -> one trading80_call_alerts row, or None if not usable."""
    stockid = str(raw.get("stockid") or "")
    symbol = sid_map.get(stockid)
    if not symbol:
        return None
    call_id = raw.get("id")
    calltime = (raw.get("calltime") or "").strip()
    if not call_id:
        # "changes" rows carry a null id upstream (module docstring) -- fall back to a
        # composite key instead of dropping the row outright.
        if not stockid or not calltime:
            return None
        call_id = f"{stockid}:{calltime}"

    return {
        "id": f"trading80:{list_name}:{call_id}",
        "symbol": symbol,
        "list_name": list_name,
        "call_time_label": (raw.get("calltime") or "").strip() or None,
        "call_type": (raw.get("type") or "").strip() or None,
        "call_duration": (raw.get("call_duration") or "").strip() or None,
        "target_price": _num(raw, "tprice"),
        "stop_loss": _num(raw, "SL"),
        "cmp": _num(raw, "cmp"),
        "potential_pct": _num(raw, "potential"),
        "performance_pct": _num(raw, "performance"),
        "prob_success_label": (raw.get("prob_success") or "").strip() or None,
        "source": SOURCE,
    }


COLS = ["id", "symbol", "list_name", "call_time_label", "call_type", "call_duration",
        "target_price", "stop_loss", "cmp", "potential_pct", "performance_pct",
        "prob_success_label", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS trading80_call_alerts (
            id TEXT PRIMARY KEY, symbol TEXT NOT NULL, list_name TEXT NOT NULL,
            call_time_label TEXT, call_type TEXT, call_duration TEXT,
            target_price REAL, stop_loss REAL, cmp REAL,
            potential_pct REAL, performance_pct REAL, prob_success_label TEXT,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO trading80_call_alerts ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (id) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def run() -> int:
    conn = connect()
    try:
        ensure_schema(conn)
        sid_map = load_sid_to_symbol_map()
        by_list = fetch_call_alerts()
        total = 0
        for list_name, raw_rows in by_list.items():
            rows = [r for r in (parse_call(list_name, c, sid_map) for c in raw_rows) if r is not None]
            n = store(conn, rows)
            total += n
            print(f"[Trading80Calls] {list_name}: {len(raw_rows)} seen, {n} stored", flush=True)
        return total
    finally:
        conn.close()


def main() -> int:
    n = run()
    if n == 0:
        print("[Trading80Calls] nothing stored", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class Trading80CallAlertsFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class Trading80CallAlertsFetcherBaseFetcher(BaseFetcher[Trading80CallAlertsFetcherSchema]):
    fetcher_name = 'Trading80CallAlertsFetcher'
    domain = 'general'
    schema = Trading80CallAlertsFetcherSchema
    min_interval_sec = 0.5

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
