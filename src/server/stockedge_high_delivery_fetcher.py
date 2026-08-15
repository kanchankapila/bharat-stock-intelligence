#!/usr/bin/env python3
"""
StockEdge "Higher Delivery Quantity" alert list.

WHY THIS EXISTS
----------------
Promoted from `endpoint_registry.py`'s `CURATED_EXTRA_ENDPOINTS` (`stockedge_high_delivery_qty`,
added 2026-07-30), where it was archived raw into `extra_endpoint_responses` (symbol='MARKET')
and never parsed. `Symb` is already a real NSE ticker (confirmed live: LGEINDIA, ASTRAL,
URBANCO, SARDAEN) -- no id resolution needed, unlike the rest of StockEdge's per-stock API
surface (which uses its own opaque `SecurityID`, unrelated to stocklist.json, and was
deliberately NOT promoted for that reason -- see endpoint_registry.py's Round-1 comment).

    https://api.stockedge.com/Api/WidgetsApi/GetHighDeliveryQuantityStocks?lang=en

Live-verified 2026-08-14/15: 5 rows/day, `TimesDQ` = today's delivery qty as a multiple of the
trailing 5-day average -- a delivery-SPIKE detector under a different name. Note for anyone
reading this as an ML candidate: `measurement.md`'s "Already tested" table already measured
this exact construct (`delivery_spike`/`delivery_trend`, t=-1.08/-1.43) as dead. This fetcher
exists for archival/cross-check value at near-zero cost (5 rows/day), not because the signal is
expected to have edge -- do not wire it into scoring without a fresh factor_backtest.py run.

Run:
  python stockedge_high_delivery_fetcher.py
"""
import sys

import requests

from db_compat import connect, ConnWrapper, query_all

API = "https://api.stockedge.com/Api/WidgetsApi/GetHighDeliveryQuantityStocks?lang=en"
SOURCE = "stockedge"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

COLS = ["id", "alert_date", "symbol", "security_id", "exch", "name",
        "times_delivery_qty", "delivery_qty", "avg_5d_delivery_qty",
        "close", "close_chg_pct", "slug", "source"]


def _log(m):
    print(f"[StockEdgeDelivery] {m}", flush=True)


def fetch_alerts() -> list:
    """The ONLY fetch path -- tests call this, never a reimplementation."""
    r = requests.get(API, headers=HEADERS, timeout=20)
    r.raise_for_status()
    payload = r.json()
    if not isinstance(payload, dict):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload.get("Alerts") or []


def parse_alert(raw: dict, universe: set) -> dict | None:
    """One API row -> one stockedge_high_delivery_alerts row, or None if not usable."""
    symbol = (raw.get("Symb") or "").strip().upper()
    if not symbol or symbol not in universe:
        return None
    alert_id = raw.get("ID")
    alert_date = (raw.get("Date") or "")[:10]
    if alert_id is None or not alert_date:
        return None
    info = raw.get("Info") or {}
    if not isinstance(info, dict):
        info = {}

    def num(d, k):
        v = d.get(k)
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return None if f != f else f  # NaN -> None

    return {
        "id": f"stockedge:{alert_id}",
        "alert_date": alert_date,
        "symbol": symbol,
        "security_id": raw.get("SecurityID"),
        "exch": (raw.get("Exch") or "").strip() or None,
        "name": (raw.get("Name") or "").strip() or None,
        "times_delivery_qty": num(info, "TimesDQ"),
        "delivery_qty": num(info, "DQ1"),
        "avg_5d_delivery_qty": num(info, "Avg5DQ"),
        "close": num(info, "C1"),
        "close_chg_pct": num(info, "C1ZG"),
        "slug": (raw.get("Slug") or "").strip() or None,
        "source": SOURCE,
    }


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stockedge_high_delivery_alerts (
            id TEXT PRIMARY KEY, alert_date TEXT NOT NULL, symbol TEXT NOT NULL,
            security_id INTEGER, exch TEXT, name TEXT,
            times_delivery_qty REAL, delivery_qty REAL, avg_5d_delivery_qty REAL,
            close REAL, close_chg_pct REAL, slug TEXT,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO stockedge_high_delivery_alerts ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (id) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def load_nse_universe() -> set:
    rows = query_all("SELECT symbol FROM nse_stocks")
    return {(r["symbol"] or "").upper() for r in rows if r.get("symbol")}


def run() -> int:
    conn = connect()
    try:
        ensure_schema(conn)
        universe = load_nse_universe()
        raw_rows = fetch_alerts()
        rows = [r for r in (parse_alert(a, universe) for a in raw_rows) if r is not None]
        n = store(conn, rows)
        _log(f"{len(raw_rows)} seen, {n} stored")
        return n
    finally:
        conn.close()


def main() -> int:
    n = run()
    if n == 0:
        _log("nothing stored")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
