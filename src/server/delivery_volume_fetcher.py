#!/usr/bin/env python3
"""
Delivery Volume % Fetcher (NSE MTO Security-Wise Delivery Data)
================================================================
Downloads NSE's daily MTO (Security-Wise Delivery Position) DAT file and
computes delivery % per stock — the fraction of traded volume that resulted
in actual delivery (i.e. held overnight, not squared intraday).

Why it matters for ML:
  High delivery % → institutional/positional conviction in direction.
  Low delivery %  → speculative / intraday noise; signal less reliable.

Source: https://nsearchives.nseindia.com/archives/equities/mto/MTO_DDMMYYYY.DAT
Format: Fixed comma-delimited text, record type 20 per stock.
Fields: record_type, sr_no, symbol, series, qty_traded, deliverable_qty, delivery_pct

Writes to:
  stock_delivery_volume (symbol, date, series, qty_traded, deliverable_qty, delivery_pct)
  technical_signals.delivery_pct (back-filled for today)

Run:
  python delivery_volume_fetcher.py              # last trading day
  python delivery_volume_fetcher.py --days 30    # backfill 30 days
  python delivery_volume_fetcher.py --date 2026-06-24
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class DeliveryVolumeFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class DeliveryVolumeFetcherBaseFetcher(BaseFetcher[DeliveryVolumeFetcherSchema]):
    fetcher_name = 'DeliveryVolumeFetcher'
    domain = 'general'
    schema = DeliveryVolumeFetcherSchema
    min_interval_sec = 0.5


import argparse
import io
import time
from datetime import date, datetime, timedelta

import requests

from db_compat import connect, safe_alter
from fetch_utils import retry_get
import sys

MTO_URL = "https://nsearchives.nseindia.com/archives/equities/mto/MTO_{date}.DAT"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Referer": "https://nseindia.com/",
}

RATE_LIMIT_SEC = 0.8

# Only track EQ series (equity) and BE (book entry / T+0) — skip SME/debt/others
EQUITY_SERIES = {"EQ", "BE", "BL", "N1", "NR", "MF"}


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_delivery_volume (
            symbol          TEXT NOT NULL,
            date            TEXT NOT NULL,
            series          TEXT,
            qty_traded      BIGINT,
            deliverable_qty BIGINT,
            delivery_pct    REAL,
            fetched_at      TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    for idx in [
        "CREATE INDEX IF NOT EXISTS idx_sdv_date   ON stock_delivery_volume(date)",
        "CREATE INDEX IF NOT EXISTS idx_sdv_symbol ON stock_delivery_volume(symbol, date DESC)",
    ]:
        cur.execute(idx)
    con.commit()  # commit DDL before ALTER (Postgres aborts tx on failed ALTER)

    # Add delivery_pct to technical_signals if not present
    safe_alter(None, "ALTER TABLE technical_signals ADD COLUMN delivery_pct REAL")



def _trading_days_back(n: int, con=None) -> list[date]:
    """Real trading sessions, newest first. Delegates to the shared helper -- the old
    weekday-only version was holiday-blind, so --days 30 silently covered fewer than 30 real
    sessions whenever a holiday fell in range."""
    from as_of import trading_days_back
    return trading_days_back(n, con)


def fetch_mto(trade_date: date, session: requests.Session) -> list[dict] | None:
    """Download and parse MTO DAT file. Returns list of row dicts or None on failure."""
    url = MTO_URL.format(date=trade_date.strftime("%d%m%Y"))
    try:
        r = retry_get(session, url, timeout=15)
    except Exception as e:
        status = getattr(getattr(e, 'response', None), 'status_code', None)
        if status == 404:
            # No file published for this date = no session. Distinct from a failure: return
            # an empty list, so a caller can tell "nothing happened" from "we don't know".
            # Both used to return None, which made a throttled run look like a run of
            # holidays -- the same silent-partial-failure contract bug fixed in
            # insider_transactions_fetcher.py.
            return []
        print(f"[Delivery] {trade_date}: download failed after retries — {e}", file=sys.stderr)
        return None

    rows = []
    for line in r.text.splitlines():
        if not line.startswith("20,"):
            continue
        parts = line.split(",")
        if len(parts) < 7:
            continue
        # Fields: record_type, sr_no, symbol, series, qty_traded, deliverable_qty, delivery_pct
        symbol       = parts[2].strip()
        series       = parts[3].strip()
        try:
            qty_traded      = int(parts[4])
            deliverable_qty = int(parts[5])
            delivery_pct    = float(parts[6])
        except (ValueError, IndexError):
            continue

        rows.append({
            "symbol":          symbol,
            "date":            trade_date,
            "series":          series,
            "qty_traded":      qty_traded,
            "deliverable_qty": deliverable_qty,
            "delivery_pct":    delivery_pct,
        })

    return rows


def upsert_rows(rows: list[dict], con) -> None:
    if not rows:
        return
    cur = con.cursor()
    for r in rows:
        cur.execute("""
            INSERT INTO stock_delivery_volume
                (symbol, date, series, qty_traded, deliverable_qty, delivery_pct)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                series          = excluded.series,
                qty_traded      = excluded.qty_traded,
                deliverable_qty = excluded.deliverable_qty,
                delivery_pct    = excluded.delivery_pct,
                fetched_at      = CURRENT_TIMESTAMP
        """, (
            r["symbol"], r["date"], r["series"],
            r["qty_traded"], r["deliverable_qty"], r["delivery_pct"],
        ))
    con.commit()


def backfill_technical_signals(today: str, con) -> int:
    """Copy delivery_pct into technical_signals for the ML pipeline.

    Heals BOTH `today` and the previous sourced session (2026-08-25): MTO files are
    typically published ~18:00-19:30 IST and this runs in the evening chain, but a
    15:30 IST intraday scan can already have written that day's grid rows with an
    empty deliveryMap (deliveryFetcher.ts returns Map() silently when NSE hasn't
    published yet). Measured live 2026-08-24: delivery_pct was 0/2,198 rows on the
    Monday grid even though Friday's data existed and tonight's fetch succeeded --
    the copy only ever targeted `today`'s rows, so the gap persisted until the next
    day. Writing the prior session too closes that window without any second job.
    """
    cur = con.cursor()
    total = 0
    sessions = [str(r['d'])[:10] for r in con.execute(
        "SELECT DISTINCT date AS d FROM stock_delivery_volume "
        "WHERE date <= ? ORDER BY d DESC LIMIT 2", (today,)).fetchall()]
    if today not in sessions:
        sessions = [today] + sessions
    for d in dict.fromkeys(sessions):
        cur.execute("""
            UPDATE technical_signals
            SET delivery_pct = (
                SELECT delivery_pct FROM stock_delivery_volume
                WHERE symbol = technical_signals.symbol AND date = ?
                LIMIT 1
            )
            WHERE date = ? AND delivery_pct IS NULL
        """, (d, d))
        n = cur.rowcount
        total += max(n, 0)
        print(f"[Delivery] {d}: filled delivery_pct on {n} technical_signals rows")
    con.commit()
    return total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=1,
                        help="Backfill last N trading days (default: 1)")
    parser.add_argument("--date", type=str, default=None,
                        help="Fetch a single date (YYYY-MM-DD)")
    parser.add_argument("--force", action="store_true", default=False,
                        help="Force re-fetch even if data is already populated")
    args = parser.parse_args()


    con = connect()
    ensure_schema(con)
    con.commit()  # DDL must commit before DML in Postgres

    session = requests.Session()
    session.headers.update(HEADERS)

    if args.date:
        dates = [datetime.strptime(args.date, "%Y-%m-%d").date()]
    else:
        dates = _trading_days_back(args.days, con)

    total = failed = 0
    for i, trade_date in enumerate(dates):
        # Delta check: if bhavcopy or prior run already stored >= 1000 stocks for trade_date, skip MTO download
        if not args.force:
            cur = con.cursor()
            cur.execute("SELECT count(*) FROM stock_delivery_volume WHERE date = ?", (trade_date.isoformat(),))
            c = cur.fetchone()
            count = c[0] if isinstance(c, (tuple, list)) else (c['count'] if hasattr(c, '__getitem__') and 'count' in c else list(dict(c).values())[0])
            if count and int(count) >= 1000:
                print(f"[Delivery] {trade_date}: already has {count} rows (from bhavcopy/prior fetch) — skipped redundant MTO download.")
                continue

        print(f"[Delivery] Fetching {trade_date} ({i+1}/{len(dates)})…")
        rows = fetch_mto(trade_date, session)

        if rows is None:
            failed += 1
            print(f"[Delivery] {trade_date}: FETCH FAILED (not a holiday — investigate)")
            continue
        if not rows:
            print(f"[Delivery] {trade_date}: no session (holiday / not yet published)")
            continue
        upsert_rows(rows, con)
        print(f"[Delivery] {trade_date}: {len(rows)} stocks saved")
        total += len(rows)
        if i < len(dates) - 1:
            time.sleep(RATE_LIMIT_SEC)

    most_recent = dates[0].isoformat() if dates else None
    if most_recent:
        updated = backfill_technical_signals(most_recent, con)
        print(f"[Delivery] Updated {updated} technical_signals rows for {most_recent}")

    print(f"[Delivery] Done. Total rows: {total}")
    con.close()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
