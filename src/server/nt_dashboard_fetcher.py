#!/usr/bin/env python3
"""
NiftyTrader F&O Dashboard Fetcher (Daily)
==========================================
Single API call → 147 F&O stocks with per-stock options data not available
from any other source we use:

  max_pain_level        — price at which maximum options contracts expire worthless
                          (stock gravitates toward this level near expiry)
  total_calls_change_oi — call OI delta today (positive = more calls written = bearish hedge)
  total_puts_change_oi  — put OI delta today (positive = more puts written = bearish view)
  pcr                   — put-call ratio per stock (independent of pcr_fetcher)
  option_volume         — total options activity (event anticipation signal)

Unique vs existing sources:
  - pcr_fetcher.py (pcr_oi/pcr_vol) covers overall PCR and ATM IV — this adds max_pain
    and the DIRECTIONAL split of OI change (calls vs puts separately)
  - oi_delta_features.py covers total OI change — this adds the call/put breakdown
  - optionChainService.ts computes max_pain for the symbol being queried — this gives
    max_pain for ALL 147 F&O stocks in one call

ML features written to technical_signals:
  nt_max_pain_dist_pct  = (ltp - max_pain) / max_pain * 100  (+ = above pain, - = below)
  nt_oi_direction       = (puts_Δoi - calls_Δoi) / total_oi  (positive = put bias = bearish)
  nt_pcr                = put-call ratio (second-source confirmation)
  nt_option_volume_log  = log(total option_volume + 1)  (activity level)

Run:
  python nt_dashboard_fetcher.py             # all 147 F&O stocks
  python nt_dashboard_fetcher.py --symbol BEL
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class NtDashboardFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class NtDashboardFetcherBaseFetcher(BaseFetcher[NtDashboardFetcherSchema]):
    fetcher_name = 'NtDashboardFetcher'
    domain = 'niftytrader.in'
    schema = NtDashboardFetcherSchema
    min_interval_sec = 0.5


import argparse
import math
import time
from datetime import date

import requests

from db_compat import connect, translate
from as_of import logical_write_floor
import sys

DASHBOARD_URL = "https://webapi.niftytrader.in/webapi/Option/dashboard-data"

HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
}


# ── Schema ───────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS nt_fno_dashboard (
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            ltp             REAL,
            change_pct      REAL,
            lot_size        INTEGER,
            max_pain        REAL,
            max_pain_dist_pct REAL,
            pcr             REAL,
            total_calls_oi  REAL,
            total_puts_oi   REAL,
            total_oi        REAL,
            total_calls_vol REAL,
            total_puts_vol  REAL,
            option_volume   REAL,
            calls_oi_change REAL,
            puts_oi_change  REAL,
            oi_direction    REAL,
            fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """))
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ntfd_sym ON nt_fno_dashboard(symbol, date DESC)")
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN nt_max_pain_dist_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN nt_oi_direction       REAL",
        "ALTER TABLE technical_signals ADD COLUMN nt_pcr                REAL",
        "ALTER TABLE technical_signals ADD COLUMN nt_option_volume_log  REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Fetch ────────────────────────────────────────────────────────────────────

def _fetch_all() -> dict | None:
    try:
        r = requests.get(DASHBOARD_URL, headers=HEADERS, timeout=15)
        if r.status_code != 200:
            print(f"[NTDashboard] HTTP {r.status_code}")
            return None
        payload = r.json()
        if payload.get("result") != 1:
            print(f"[NTDashboard] API error: {payload.get('resultMessage')}")
            return None
        return payload.get("resultData", {})
    except Exception as e:
        print(f"[NTDashboard] fetch error: {e}", file=sys.stderr)
        return None


def _sf(v, default=None):
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _parse_record(row: dict, today: str) -> dict | None:
    symbol = row.get("symbol_name", "").strip().upper()
    if not symbol:
        return None

    ltp        = _sf(row.get("last_trade_price"))
    max_pain   = _sf(row.get("max_pain_level"))
    pcr        = _sf(row.get("pcr"))
    calls_oi   = _sf(row.get("total_calls_oi"))
    puts_oi    = _sf(row.get("total_puts_oi"))
    total_oi   = _sf(row.get("total_oi"))
    calls_vol  = _sf(row.get("total_calls_volume"))
    puts_vol   = _sf(row.get("total_puts_volume"))
    opt_vol    = _sf(row.get("option_volume"))
    calls_chg  = _sf(row.get("total_calls_change_oi"))
    puts_chg   = _sf(row.get("total_puts_change_oi"))
    lot_size   = row.get("lot_size")
    try:
        lot_size = int(float(lot_size)) if lot_size else None
    except (TypeError, ValueError):
        lot_size = None

    # (price - max_pain) / max_pain * 100: negative = price below max pain = pull upward
    max_pain_dist = round((ltp - max_pain) / max_pain * 100, 2) \
                    if ltp and max_pain and max_pain > 0 else None

    # (puts_Δoi - calls_Δoi) / total_oi: positive = put buildup = bearish option sentiment
    oi_direction = round((puts_chg - calls_chg) / total_oi, 4) \
                   if puts_chg is not None and calls_chg is not None \
                   and total_oi and total_oi > 0 else None

    return {
        "symbol":          symbol,
        "date":            today,
        "ltp":             ltp,
        "change_pct":      _sf(row.get("change_percent")),
        "lot_size":        lot_size,
        "max_pain":        max_pain,
        "max_pain_dist_pct": max_pain_dist,
        "pcr":             pcr,
        "total_calls_oi":  calls_oi,
        "total_puts_oi":   puts_oi,
        "total_oi":        total_oi,
        "total_calls_vol": calls_vol,
        "total_puts_vol":  puts_vol,
        "option_volume":   opt_vol,
        "calls_oi_change": calls_chg,
        "puts_oi_change":  puts_chg,
        "oi_direction":    oi_direction,
    }


def upsert_row(f: dict, con) -> None:
    cur = con.cursor()
    cur.execute(translate("""
        INSERT INTO nt_fno_dashboard (
            symbol, date, ltp, change_pct, lot_size,
            max_pain, max_pain_dist_pct, pcr,
            total_calls_oi, total_puts_oi, total_oi,
            total_calls_vol, total_puts_vol, option_volume,
            calls_oi_change, puts_oi_change, oi_direction
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            ltp=excluded.ltp, change_pct=excluded.change_pct,
            max_pain=excluded.max_pain, max_pain_dist_pct=excluded.max_pain_dist_pct,
            pcr=excluded.pcr,
            total_calls_oi=excluded.total_calls_oi, total_puts_oi=excluded.total_puts_oi,
            total_oi=excluded.total_oi,
            total_calls_vol=excluded.total_calls_vol, total_puts_vol=excluded.total_puts_vol,
            option_volume=excluded.option_volume,
            calls_oi_change=excluded.calls_oi_change, puts_oi_change=excluded.puts_oi_change,
            oi_direction=excluded.oi_direction,
            fetched_at=CURRENT_TIMESTAMP
    """), (
        f["symbol"], f["date"], f.get("ltp"), f.get("change_pct"), f.get("lot_size"),
        f.get("max_pain"), f.get("max_pain_dist_pct"), f.get("pcr"),
        f.get("total_calls_oi"), f.get("total_puts_oi"), f.get("total_oi"),
        f.get("total_calls_vol"), f.get("total_puts_vol"), f.get("option_volume"),
        f.get("calls_oi_change"), f.get("puts_oi_change"), f.get("oi_direction"),
    ))
    con.commit()


def backfill_technical_signals(ts_floor: str, f: dict, con) -> None:
    """date >= ? ELSE NULL guard added 2026-07-19 -- see mc_pricefeed_fetcher.py's
    backfill_technical_signals for the full writeup of the no-date-filter bug this fixes.

    BUG FOUND 2026-07-28 (Finding #64 of the full-stack audit): the guard threshold
    (`ts_floor`, named `today` before this fix) was date.today() -- the same bug class
    already fixed in 6 sibling fetchers on 2026-07-25, copied here *after* that fix
    existed. On a closed-market day this job still runs, date.today() matches zero
    technical_signals rows, and the ELSE branch nulls nt_max_pain_dist_pct/nt_pcr/etc
    across a symbol's entire history. Caller must pass the last completed trading
    session (MAX(date) FROM stock_ohlcv), not raw date.today() -- see main()."""
    opt_vol = f.get("option_volume")
    vol_log = round(math.log1p(opt_vol), 4) if opt_vol and opt_vol > 0 else None

    cur = con.cursor()
    cur.execute(translate("""
        UPDATE technical_signals SET
            nt_max_pain_dist_pct = CASE WHEN date >= ? THEN COALESCE(?, nt_max_pain_dist_pct) ELSE NULL END,
            nt_oi_direction      = CASE WHEN date >= ? THEN COALESCE(?, nt_oi_direction)      ELSE NULL END,
            nt_pcr               = CASE WHEN date >= ? THEN COALESCE(?, nt_pcr)               ELSE NULL END,
            nt_option_volume_log = CASE WHEN date >= ? THEN COALESCE(?, nt_option_volume_log) ELSE NULL END
        WHERE symbol = ?
    """), (
        ts_floor, f.get("max_pain_dist_pct"),
        ts_floor, f.get("oi_direction"),
        ts_floor, f.get("pcr"),
        ts_floor, vol_log,
        f["symbol"],
    ))
    con.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    today = date.today().isoformat()
    ts_floor = logical_write_floor(fallback=today)
    data = _fetch_all()
    if data is None:
        print("[NTDashboard] No data returned.")
        con.close()
        return

    stocks = data.get("stocks", [])
    indices = data.get("indices", [])
    all_rows = stocks + indices  # indices: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY

    if args.symbol:
        all_rows = [r for r in all_rows if r.get("symbol_name", "").upper() == args.symbol.upper()]

    ok = 0
    for row in all_rows:
        f = _parse_record(row, today)
        if f is None:
            continue
        upsert_row(f, con)
        backfill_technical_signals(ts_floor, f, con)
        ok += 1

    print(f"[NTDashboard] Done. {ok} records upserted (stocks={len(stocks)}, indices={len(indices)}).")
    con.close()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
