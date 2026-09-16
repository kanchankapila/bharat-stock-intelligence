#!/usr/bin/env python3
"""
MarketsMojo's own model-portfolio stock picks -- entry date/price and live/exit P&L.

WHY THIS EXISTS
----------------
Promoted from `endpoint_registry.py`'s `CURATED_EXTRA_ENDPOINTS` (`marketsmojo_stock_picks_history`,
added 2026-07-30), where it was archived raw into `extra_endpoint_responses` (symbol='MARKET')
and never parsed.

    https://frapi.marketsmojo.com/optimizer_Portfoliodignostic/getMojostocksHist

Live-verified 2026-08-15: `data.activestocks` (currently open picks) + `data.allstocks`
(open + closed) -- 2-3 rows total on a normal day. This is genuinely distinct data, not a
rehash of MarketsMojo's `dot_summary` score already captured elsewhere: it is the vendor's OWN
curated buy list with a real entry date/price and running P&L, not a per-stock composite score.
(Contrast `marketsmojo_results_corner`, the sibling curated_extra endpoint left archived-only --
its per-row `dotsum` block is the identical q_rank/v_rank/f_pts/tech_score fields
`marketsmojo_header_info` already captures for the full ~1,831-stock universe, confirmed
byte-identical 2026-07-30 per extra_features_parser.py's own comment -- building a table for it
would store nothing new.)

Each row carries Trading80/MarketsMojo's shared `stockid` (scripts/stocklist.json), resolved
the same inverted way `trading80_call_alerts_fetcher.py`'s `load_sid_to_symbol_map()` does --
reused directly here rather than re-implementing the same map (Trading80 and MarketsMojo share
this id space, per data-sources.md's MarketsMojo-onboarding note).

THIS IS A VENDOR'S OWN PICK LIST, not a measured factor of this platform's. Do not wire into
scoring without a fresh factor_backtest.py-style measurement against realized returns --
`mojo_indigraph` (measurement.md), MarketsMojo's other standing directional call, measured
-0.08 to -0.14%/period, no edge.

Run:
  python marketsmojo_stock_picks_fetcher.py
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class MarketsmojoStockPicksFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class MarketsmojoStockPicksFetcherBaseFetcher(BaseFetcher[MarketsmojoStockPicksFetcherSchema]):
    fetcher_name = 'MarketsmojoStockPicksFetcher'
    domain = 'marketsmojo.com'
    schema = MarketsmojoStockPicksFetcherSchema
    min_interval_sec = 0.5

import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect, ConnWrapper
from trading80_call_alerts_fetcher import load_sid_to_symbol_map  # noqa: E402

API = "https://frapi.marketsmojo.com/optimizer_Portfoliodignostic/getMojostocksHist"
SOURCE = "marketsmojo"
LISTS = ("activestocks", "allstocks")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.marketsmojo.com/",
}


def fetch_picks() -> dict:
    """The ONLY fetch path -- tests call this, never a reimplementation. Returns
    {"activestocks": [...], "allstocks": [...]}."""
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
        f = float(str(v).replace(",", "").replace("%", ""))
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def parse_pick(list_name: str, raw: dict, sid_map: dict) -> dict | None:
    """One API row -> one marketsmojo_stock_picks row, or None if not usable."""
    stockid = str(raw.get("stockid") or "")
    symbol = sid_map.get(stockid)
    if not symbol:
        return None
    added_date = (raw.get("added_date") or "").strip()
    if not added_date:
        return None

    is_open = (raw.get("exit_date") or "").strip().lower() == "currently live"
    return {
        "id": f"marketsmojo:{list_name}:{stockid}:{added_date}",
        "symbol": symbol,
        "list_name": list_name,
        "added_date_label": added_date,
        "exit_date_label": (raw.get("exit_date") or "").strip() or None,
        "is_open": 1 if is_open else 0,
        "entry_price": _num(raw, "entry_price"),
        "exit_price": _num(raw, "exit_price"),
        "change_pct": _num(raw, "change_perc"),
        "current_price": _num(raw, "currentprice"),
        "bse500_return_pct": _num(raw, "bse500return"),
        "source": SOURCE,
    }


COLS = ["id", "symbol", "list_name", "added_date_label", "exit_date_label", "is_open",
        "entry_price", "exit_price", "change_pct", "current_price", "bse500_return_pct", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS marketsmojo_stock_picks (
            id TEXT PRIMARY KEY, symbol TEXT NOT NULL, list_name TEXT NOT NULL,
            added_date_label TEXT, exit_date_label TEXT, is_open INTEGER,
            entry_price REAL, exit_price REAL, change_pct REAL,
            current_price REAL, bse500_return_pct REAL,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO marketsmojo_stock_picks ({', '.join(COLS)}) VALUES ({ph}) "
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
        by_list = fetch_picks()
        total = 0
        for list_name, raw_rows in by_list.items():
            rows = [r for r in (parse_pick(list_name, p, sid_map) for p in raw_rows) if r is not None]
            n = store(conn, rows)
            total += n
            print(f"[MojoPicks] {list_name}: {len(raw_rows)} seen, {n} stored", flush=True)
        return total
    finally:
        conn.close()


def main() -> int:
    n = run()
    if n == 0:
        print("[MojoPicks] nothing stored", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
