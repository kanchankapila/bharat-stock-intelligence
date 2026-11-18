#!/usr/bin/env python3
"""
Per-stock historical PE-band chart (price + rolling PE deciles) from InvestSights.

WHY THIS EXISTS
---------------
Onboarded via `onboard-data-source`, 2026-08-13 batch pass. No table on this platform stores
a rolling PE-band series today -- `mc_stockvitals_history_fetcher.py` has point-in-time
Graham/Altman/etc., but nothing tracks "is this stock's PE cheap or rich relative to its OWN
recent history," which is what `pe_bands`/`chart` actually encode.

    https://investsights.in/api/v2/market/pe-band/{symbol}?days=1095

**Path correction, 2026-08-14**: the endpoint originally captured lived under `/market/`, not
`/fundamentals/{symbol}/pe-band` as this fetcher was first (wrongly) built against -- a
different base path on the same host, not the same endpoint moved/removed. The onboarding
session tested only the `/fundamentals/` guess (never the real path) after the capture had
scrolled out of context, saw 404 across every symbol and several other guessed variants, and
concluded the endpoint had gone dark -- wrong conclusion, right symptom (a 404 IS what a wrong
path returns). Corrected after the user supplied the real, working URL directly. Lesson: a
404 on every guessed path variant means "none of the guesses are right," not "the endpoint is
dead" -- the two are indistinguishable from the client side, so don't conflate them in the
write-up. `days` bounds the chart's lookback in days; 1095 (~3 years) comfortably covers the
full available history (~2 years back to 2023-08-14, confirmed below).

Ticker resolution: bare NSE symbol, confirmed trivial (see investsights_fundamentals_fetcher.py's
docstring -- same provider, same finding, not re-derived here).

SHAPE -- verified live, WEBELSOLAR + RELIANCE, 2026-08-14
------------------------------------------------------------
`{eps, current_pe, pe_bands: {low, mid_low, median, mid_high, high}, chart: [{date, price, pe,
band_low, band_mid_low, band_median, band_mid_high, band_high}, ...]}`. `chart` is a genuine
daily series back to 2023-08-14 (~2 years, 246 rows for RELIANCE at days=1095) -- this is the
rare InvestSights endpoint that arrives with real history already, not a 1-row snapshot.
`pe_bands` (singular, top-level) is just `chart[-1]`'s five band values restated -- NOT stored
separately, `chart`'s last row already has it.

APPEND ONLY since 2026-11-18 (AF-20261019-02). The vendor rebuilds every historical chart point
from its CURRENT bands, so the old full re-upsert rewrote three years of rows with later
information (ACC: 767 rows, 5 distinct band_median values; one value on every date from 2025-01
to 2026-09) and a backtest on the table read IC 0.42 out of look-ahead. Each run now writes only
dates after the symbol's newest stored date and never updates a stored row, so each row keeps the
band as first seen. Rows dated on or before 2026-11-17 are NOT point in time; measure only rows
dated after it.

UNIVERSE / AS-OF: same as investsights_fundamentals_fetcher.py -- nse_stocks ACTIVE by
market_cap, --limit bound, --symbol override.

Run:
  python investsights_pe_band_fetcher.py --limit 300
  python investsights_pe_band_fetcher.py --symbol RELIANCE
"""

import argparse
import sys
import time

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get, FetchTracker
from as_of import logical_write_floor

BASE = "https://investsights.in/api/v2/market/pe-band"
SOURCE = "investsights"
RATE_LIMIT_SEC = 0.3
DAYS_LOOKBACK = 1095  # ~3yr, comfortably covers the full available history (~2yr)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def _log(m):
    print(f"[InvestsightsPeBand] {m}", flush=True)


def _num(raw, k):
    v = raw.get(k)
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def fetch_pe_band(session: requests.Session, symbol: str) -> dict | None:
    resp = retry_get(session, f"{BASE}/{symbol}", params={"days": DAYS_LOOKBACK}, timeout=20)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    return payload.get("data")


def parse_chart_rows(symbol: str, data: dict | None) -> list[dict]:
    if not data:
        return []
    rows = []
    for pt in data.get("chart") or []:
        date = (pt.get("date") or "")[:10]
        if not date:
            continue
        rows.append({
            "symbol": symbol, "date": date,
            "price": _num(pt, "price"), "pe": _num(pt, "pe"),
            "band_low": _num(pt, "band_low"), "band_mid_low": _num(pt, "band_mid_low"),
            "band_median": _num(pt, "band_median"), "band_mid_high": _num(pt, "band_mid_high"),
            "band_high": _num(pt, "band_high"),
            "source": SOURCE,
        })
    return rows


COLS = ["symbol", "date", "price", "pe", "band_low", "band_mid_low", "band_median",
        "band_mid_high", "band_high", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS investsights_pe_band_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            price REAL, pe REAL, band_low REAL, band_mid_low REAL, band_median REAL,
            band_mid_high REAL, band_high REAL, source TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    conn.commit()


def load_known_max_dates(conn: ConnWrapper) -> dict[str, str]:
    rows = conn.execute(
        "SELECT symbol, MAX(date)::text FROM investsights_pe_band_history GROUP BY symbol").fetchall()
    return {r[0]: r[1] for r in rows if r[1]}


def store_rows(conn: ConnWrapper, rows: list[dict], known: dict[str, str] | None = None,
               through: str | None = None) -> int:
    """Append only: dates after the symbol's newest stored date and on or before `through` (the
    latest completed session, so an in-progress point from a market-hours run is never frozen),
    and never a rewrite of a stored row."""
    known = known or {}
    rows = [r for r in rows if known.get(r["symbol"], "") < r["date"] <= (through or "9999")]
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    sql = (f"INSERT INTO investsights_pe_band_history ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (symbol, date) DO NOTHING")
    for row in rows:
        conn.execute(sql, tuple(row[c] for c in COLS))
    conn.commit()
    return len(rows)


def _load_universe(conn: ConnWrapper, symbol_filter: str | None, limit: int) -> list[str]:
    if symbol_filter:
        return [symbol_filter.upper()]
    rows = conn.execute("""
        SELECT symbol FROM nse_stocks WHERE status = 'ACTIVE' AND market_cap IS NOT NULL
        ORDER BY market_cap DESC LIMIT ?
    """, (limit,)).fetchall()
    return [r["symbol"] if hasattr(r, "keys") else r[0] for r in rows]


def run(symbol_filter: str | None = None, limit: int = 300) -> dict:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    result = {"attempted": 0, "symbols_fetched": 0, "symbols_stored": 0, "rows_stored": 0}
    # ponytail: fail-fast on a dead endpoint (this fetcher's own /pe-band route went 404
    # for every symbol shortly after onboarding, see module docstring) instead of grinding
    # through the full --limit with a 3-attempt retry_get backoff per symbol every night --
    # same fix as trendlyne_price_analysis_fetcher.py's 2026-08-13 WAF-block incident.
    tracker = FetchTracker("investsights_pe_band", abort_after_consecutive_fails=10)
    try:
        ensure_schema(conn)
        known = load_known_max_dates(conn)
        through = logical_write_floor(conn)
        universe = _load_universe(conn, symbol_filter, limit)
        _log(f"fetching PE bands for {len(universe)} symbols...")
        for symbol in universe:
            result["attempted"] += 1
            try:
                data = fetch_pe_band(session, symbol)
                rows = parse_chart_rows(symbol, data)
                n = store_rows(conn, rows, known, through)
                result["symbols_fetched"] += bool(rows)
                if n:
                    result["symbols_stored"] += 1
                    result["rows_stored"] += n
                tracker.record(symbol, ok=bool(rows))
            except Exception as e:
                _log(f"{symbol}: failed ({e})")
                tracker.record(symbol, ok=False)
            time.sleep(RATE_LIMIT_SEC)
        _log(f"done: {result['symbols_stored']}/{result['attempted']} symbols, "
             f"{result['rows_stored']} rows")
    finally:
        conn.close()
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--limit", type=int, default=300)
    args = ap.parse_args()
    result = run(symbol_filter=args.symbol, limit=args.limit)
    return 0 if result["symbols_fetched"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())

from pydantic import BaseModel
