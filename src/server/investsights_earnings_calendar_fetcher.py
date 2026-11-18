#!/usr/bin/env python3
"""
investsights_earnings_calendar_fetcher.py

Daily point-in-time snapshot of InvestSights' forward earnings calendar (AF-20261115-01).

    https://investsights.in/api/v2/market/fmp-earnings?days_ahead=120&days_back=0&indian_only=true

Live 2026-11-17: `{"success": true, "upcoming": [...1005 rows], "recent": [...], ...}`, each row
`{symbol: "WIMPLAST.BO" | "TCS.NS", date, eps_estimated, revenue_estimated, is_announced, ...}`.

WHY A SNAPSHOT TABLE, NOT A FEATURE
-----------------------------------
`stock_earnings_dates` knows a handful of future result dates, so `days_to_next_earnings` is
mostly NULL. This calendar lists ~1,000 upcoming Indian results, but its PROJECTED dates are
unverified: only announced dates were checked against NSE filings (95.4% same-day). A projected
date can only be graded after it passes, and only if what the vendor said on each earlier day
was kept. So every run appends that day's view and never rewrites an earlier one
(`ON CONFLICT DO NOTHING`); nothing reads this table for scoring until the miss rate by horizon
has been measured (measurement.md).

Symbols arrive Yahoo-style. The suffix is kept in `exchange`; `symbol` is set only when the bare
ticker is in `nse_stocks`, otherwise NULL (BSE-only names and numeric scrip codes stay
unresolved rather than guessed).

Run:
  python investsights_earnings_calendar_fetcher.py
"""

import argparse
import datetime
import math
import sys
from zoneinfo import ZoneInfo

import requests

from db_compat import connect, ConnWrapper, query_all
from fetch_utils import retry_get

CALENDAR_URL = "https://investsights.in/api/v2/market/fmp-earnings"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}
COLS = ["snapshot_date", "provider_symbol", "result_date", "symbol", "exchange",
        "eps_estimated", "revenue_estimated", "is_announced"]


def _log(m):
    print(f"[InvestSightsEarningsCal] {m}", flush=True)


def fetch_upcoming(session: requests.Session, days_ahead: int = 120) -> list:
    """One market-wide call. The ONLY fetch path -- tests call this."""
    resp = retry_get(session, CALENDAR_URL,
                     params={"days_ahead": days_ahead, "days_back": 0, "indian_only": "true"},
                     timeout=60)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload.get("upcoming") or []


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def parse_row(raw: dict, universe: set, snapshot_date: str) -> dict | None:
    """One calendar row -> one snapshot row, or None when it has no ticker or no ISO date."""
    provider_symbol = (raw.get("symbol") or "").strip().upper()
    result_date = (raw.get("date") or "").strip()[:10]
    if not provider_symbol or len(result_date) != 10 or result_date[4] != "-" or result_date[7] != "-":
        return None
    bare, _, suffix = provider_symbol.rpartition(".")
    if not bare:
        bare, suffix = provider_symbol, ""
    return {
        "snapshot_date": snapshot_date,
        "provider_symbol": provider_symbol,
        "result_date": result_date,
        "symbol": bare if bare in universe else None,
        "exchange": {"NS": "NSE", "BO": "BSE"}.get(suffix),
        "eps_estimated": _num(raw.get("eps_estimated")),
        "revenue_estimated": _num(raw.get("revenue_estimated")),
        "is_announced": 1 if raw.get("is_announced") else 0,
    }


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS earnings_calendar_snapshots (
            snapshot_date DATE NOT NULL, provider_symbol TEXT NOT NULL, result_date DATE NOT NULL,
            symbol TEXT, exchange TEXT, eps_estimated DOUBLE PRECISION,
            revenue_estimated DOUBLE PRECISION, is_announced INTEGER,
            source TEXT NOT NULL DEFAULT 'investsights_fmp',
            known_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (snapshot_date, provider_symbol, result_date)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ecs_symbol_result "
                 "ON earnings_calendar_snapshots (symbol, result_date)")
    conn.commit()


def store(conn: ConnWrapper, rows: list[dict]) -> int:
    """Append-only: a row already stored for this snapshot day is never rewritten."""
    ph = ",".join(["?"] * len(COLS))
    sql = (f"INSERT INTO earnings_calendar_snapshots ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (snapshot_date, provider_symbol, result_date) DO NOTHING")
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
    conn.commit()
    return len(rows)


def load_nse_universe() -> set:
    rows = query_all("SELECT symbol FROM nse_stocks")
    return {(r["symbol"] or "").upper() for r in rows if r.get("symbol")}


def run(days_ahead: int = 120) -> int:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    try:
        ensure_schema(conn)
        universe = load_nse_universe()
        upcoming = fetch_upcoming(session, days_ahead=days_ahead)
        # The observation day, IST wall clock: this row records what the vendor said TODAY.
        snapshot_date = datetime.datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
        rows = [r for r in (parse_row(u, universe, snapshot_date) for u in upcoming) if r is not None]
        store(conn, rows)
        resolved = sum(1 for r in rows if r["symbol"])
        _log(f"snapshot {snapshot_date}: {len(upcoming)} upcoming, {len(rows)} stored, "
             f"{resolved} resolved to an NSE symbol")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    if not upcoming:
        print("[InvestSightsEarningsCal] no upcoming rows returned", file=sys.stderr)
        return 1
    return 0


def main():
    ap = argparse.ArgumentParser(description="InvestSights forward earnings calendar snapshot")
    ap.add_argument("--days-ahead", type=int, default=120)
    args = ap.parse_args()
    sys.exit(run(days_ahead=args.days_ahead))


if __name__ == "__main__":
    main()
