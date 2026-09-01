#!/usr/bin/env python3
"""
Delivery Trend, Bulk/Block Deals & Short Interest Proxy Features
================================================================
Three independent feature engines in one script:

Part 1 — delivery_trend_30d
  Computes the difference between a stock's current delivery_pct and its
  30-day average. Positive = increasing genuine buying (less intraday
  speculation). Negative = more intraday = speculative activity.
  Source: stock_delivery_volume table (populated by delivery_volume_fetcher.py).
  Writes: technical_signals.delivery_trend_30d

Part 2 — bulk/block deal flags
  Fetches today's bulk deals (NSE bulk-deals API) and block deals (NSE
  block-deal API), stores them in bulk_block_deals, then derives:
    block_deal_flag      = 1 if total block deal value in last 5 days > 20 Cr
    block_deal_direction = +1 (net buy) / -1 (net sell) / 0 (none)
  Note: block_deal_net_qty / block_deal_value_cr (from block_deal_fetcher.py)
  are already in technical_signals. These new columns add a rolling flag view.
  Writes: technical_signals.block_deal_flag, technical_signals.block_deal_direction
          bulk_block_deals table

Part 3 — short interest proxy
  India has no published short-interest data. We derive a proxy from F&O:
    short_interest_proxy = total_puts_oi / (total_calls_oi + total_puts_oi)
  from nt_fno_dashboard (populated by nt_dashboard_fetcher.py).
  Range 0–1; higher = more put-heavy = more hedging / bearish positioning.
  Writes: technical_signals.short_interest_proxy

Run:
  python delivery_trend_fetcher.py             # all three parts
  python delivery_trend_fetcher.py --delivery  # only delivery trend
  python delivery_trend_fetcher.py --deals     # only bulk/block deals
  python delivery_trend_fetcher.py --short     # only short interest proxy
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class DeliveryTrendFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class DeliveryTrendFetcherBaseFetcher(BaseFetcher[DeliveryTrendFetcherSchema]):
    fetcher_name = 'DeliveryTrendFetcher'
    domain = 'general'
    schema = DeliveryTrendFetcherSchema
    min_interval_sec = 0.5


import argparse
import time
from datetime import date, timedelta

import requests

from db_compat import connect, translate
from fetch_utils import retry_get
import sys

# ── NSE session headers ───────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/",
}

# /api/bulk-deals returned 404 as of June 2026; historical endpoint with date param works.
# /api/block-deal (singular) still works without date param.
NSE_BULK_URL       = "https://www.nseindia.com/api/bulk-deals"
NSE_BULK_HIST_URL  = "https://www.nseindia.com/api/historical/bulk-deals?from={date}&to={date}&stock="
NSE_BLOCK_URL      = "https://www.nseindia.com/api/block-deal"

RATE_LIMIT_SEC = 1.0


# ── Shared schema setup ───────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    """Add new columns to technical_signals and create bulk_block_deals table."""
    cur = con.cursor()

    # bulk_block_deals — stores raw bulk and block deal rows from NSE
    cur.execute(translate("""
        CREATE TABLE IF NOT EXISTS bulk_block_deals (
            symbol       TEXT NOT NULL,
            deal_date    TEXT NOT NULL,
            deal_type    TEXT,
            client_name  TEXT,
            buy_sell     TEXT,
            quantity     REAL,
            price        REAL,
            value_cr     REAL,
            fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, deal_date, client_name, deal_type)
        )
    """))
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_bbd_sym_date "
        "ON bulk_block_deals(symbol, deal_date DESC)"
    )
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS delivery_trend_30d   REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS block_deal_flag       INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS block_deal_direction  INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS short_interest_proxy  REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Part 1: Delivery trend ────────────────────────────────────────────────────

def compute_delivery_trend(con) -> int:
    """
    delivery_trend_30d = current delivery_pct - 30-day avg delivery_pct.

    Reads from stock_delivery_volume (populated by delivery_volume_fetcher.py).
    Writes delivery_trend_30d to technical_signals for today's date.
    Returns number of rows updated.
    """
    # 2026-08-13: was raw date.today() for both the write target (ts.date = :today) AND the
    # source-table lookup (cur.date = :today) -- exact-match WHERE, not a destructive CASE-
    # WHEN, so this failed silently (0 rows) rather than nulling history, but it failed EVERY
    # time date.today() didn't match a real grid row -- confirmed live: delivery_trend_30d had
    # 0 non-null rows across the table's entire history.
    #
    # NOT logical_write_floor() either -- that anchors to stock_ohlcv, which can be a session
    # AHEAD of stock_delivery_volume mid-day (delivery %, an EOD-settled figure, genuinely
    # lags intraday price prints; confirmed live: logical_write_floor()==2026-08-13 while
    # stock_delivery_volume's own latest row was still 2026-08-12, so borrowing that anchor
    # just moved the same "today doesn't match a real row" failure onto a different table).
    # The correct floor is this fetcher's OWN source table's actual latest date.
    cur = con.cursor()
    cur.execute(translate("SELECT MAX(date) FROM stock_delivery_volume"))
    row = cur.fetchone()
    today = (row[0] if row else None) or date.today().isoformat()
    cutoff = (date.fromisoformat(today) - timedelta(days=30)).isoformat()

    cur.execute("""
            UPDATE technical_signals ts
            SET delivery_trend_30d = sub.trend
            FROM (
                SELECT
                    cur.symbol,
                    cur.delivery_pct - avg30.avg_pct AS trend
                FROM stock_delivery_volume cur
                JOIN (
                    SELECT symbol, AVG(delivery_pct) AS avg_pct
                    FROM stock_delivery_volume
                    WHERE date >= :cutoff AND date < :today
                    GROUP BY symbol
                ) avg30 ON avg30.symbol = cur.symbol
                WHERE cur.date = :today
            ) sub
            WHERE ts.symbol = sub.symbol
              AND ts.date   = :today
        """, {"cutoff": cutoff, "today": today})

    updated = cur.rowcount
    con.commit()
    return updated


# ── Part 2: Bulk/block deals ──────────────────────────────────────────────────

def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    try:
        s.get("https://www.nseindia.com/", timeout=10)
        time.sleep(0.5)
    except Exception:
        pass
    return s


def _fetch_json(session: requests.Session, url: str, params: dict | None = None) -> list[dict]:
    try:
        r = retry_get(session, url, params=params, timeout=12)
        data = r.json()
        if isinstance(data, list):
            return data
        return data.get("data", [])
    except Exception as e:
        print(f"[DeliveryTrend] Fetch error {url} after retries: {e}", file=sys.stderr)
        return []


def _parse_bulk(raw: dict, deal_type: str) -> dict | None:
    """Normalise a raw bulk or block deal row from NSE API."""
    symbol = (
        raw.get("symbol") or raw.get("Symbol") or raw.get("scrips") or ""
    ).strip().upper()
    if not symbol:
        return None

    client = (
        raw.get("clientName") or raw.get("client_name") or raw.get("clientType") or ""
    ).strip()

    buy_sell_raw = (
        raw.get("buyOrSell") or raw.get("buy_sell") or raw.get("session") or ""
    ).strip().upper()
    buy_sell = "BUY" if buy_sell_raw.startswith("B") or "BUY" in buy_sell_raw else "SELL"

    qty_raw   = raw.get("quantityTraded") or raw.get("totalTradedVolume") or raw.get("quantity") or 0
    price_raw = raw.get("wgtAvgPrice") or raw.get("lastPrice") or raw.get("price") or 0
    val_raw   = raw.get("totalTradedValue") or 0

    try:
        qty   = float(str(qty_raw).replace(",", ""))
        price = float(str(price_raw).replace(",", ""))
        value_cr = float(str(val_raw).replace(",", "")) / 1e7
        if value_cr == 0 and qty > 0 and price > 0:
            value_cr = round(qty * price / 1e7, 4)
    except (ValueError, TypeError):
        return None

    return {
        "symbol":      symbol,
        "deal_date":   date.today().isoformat(),
        "deal_type":   deal_type,
        "client_name": client,
        "buy_sell":    buy_sell,
        "quantity":    qty,
        "price":       price,
        "value_cr":    round(value_cr, 4),
    }


def upsert_deals(rows: list[dict], con) -> int:
    if not rows:
        return 0
    cur = con.cursor()
    count = 0
    for r in rows:
        cur.execute("""
                INSERT INTO bulk_block_deals
                    (symbol, deal_date, deal_type, client_name, buy_sell, quantity, price, value_cr)
                VALUES (:symbol, :deal_date, :deal_type, :client_name, :buy_sell, :quantity, :price, :value_cr)
                ON CONFLICT (symbol, deal_date, client_name, deal_type) DO UPDATE SET
                    buy_sell   = EXCLUDED.buy_sell,
                    quantity   = EXCLUDED.quantity,
                    price      = EXCLUDED.price,
                    value_cr   = EXCLUDED.value_cr,
                    fetched_at = CURRENT_TIMESTAMP
            """, {
                "symbol": r["symbol"], "deal_date": r["deal_date"],
                "deal_type": r["deal_type"], "client_name": r["client_name"],
                "buy_sell": r["buy_sell"], "quantity": r["quantity"],
                "price": r["price"], "value_cr": r["value_cr"],
            })
        count += 1
    con.commit()
    return count


def backfill_deal_flags(con) -> int:
    """
    Derive block_deal_flag and block_deal_direction from bulk_block_deals
    (last 5 days) and write to technical_signals.

    block_deal_flag      = 1 if total value across all deal types > 20 Cr
    block_deal_direction = +1 (net buys > net sells), -1, or 0
    """
    today = date.today().isoformat()
    cutoff = (date.today() - timedelta(days=5)).isoformat()
    cur = con.cursor()

    cur.execute("""
        UPDATE technical_signals ts
        SET block_deal_flag      = sub.flag,
            block_deal_direction = sub.direction
        FROM (
            SELECT symbol,
                CASE WHEN SUM(value_cr) > 20 THEN 1 ELSE 0 END AS flag,
                CASE
                    WHEN SUM(CASE WHEN buy_sell='BUY'  THEN value_cr ELSE 0 END) >
                         SUM(CASE WHEN buy_sell='SELL' THEN value_cr ELSE 0 END)
                    THEN 1
                    WHEN SUM(CASE WHEN buy_sell='SELL' THEN value_cr ELSE 0 END) >
                         SUM(CASE WHEN buy_sell='BUY'  THEN value_cr ELSE 0 END)
                    THEN -1
                    ELSE 0
                END AS direction
            FROM bulk_block_deals
            WHERE deal_date >= :cutoff
            GROUP BY symbol
        ) sub
        WHERE ts.symbol = sub.symbol
          AND ts.date   = :today
    """, {"cutoff": cutoff, "today": today})
    updated = cur.rowcount
    con.commit()
    return updated


def run_deals(con) -> tuple[int, int]:
    """Fetch bulk/block deals and update flags. Returns (deals_saved, signals_updated)."""
    session = _nse_session()
    today = date.today().isoformat()

    print(f"[DeliveryTrend] Fetching bulk deals from NSE ({today})…")
    nse_date = date.today().strftime("%d-%m-%Y")
    bulk_raw = _fetch_json(session, NSE_BULK_URL)
    if not bulk_raw:
        # /api/bulk-deals is dead (404); try historical endpoint with today's date
        bulk_raw = _fetch_json(session, NSE_BULK_HIST_URL.format(date=nse_date))
    time.sleep(RATE_LIMIT_SEC)

    print(f"[DeliveryTrend] Fetching block deals from NSE ({today})…")
    block_raw = _fetch_json(session, NSE_BLOCK_URL)

    rows = []
    for raw in bulk_raw:
        parsed = _parse_bulk(raw, "bulk")
        if parsed:
            rows.append(parsed)
    for raw in block_raw:
        parsed = _parse_bulk(raw, "block")
        if parsed:
            rows.append(parsed)

    saved = upsert_deals(rows, con)
    updated = backfill_deal_flags(con)
    return saved, updated


# ── Part 3: Short interest proxy ──────────────────────────────────────────────

def compute_short_proxy(con) -> int:
    """
    short_interest_proxy = total_puts_oi / (total_calls_oi + total_puts_oi)
    from nt_fno_dashboard (latest date per symbol).

    Range 0–1. Higher = more put-heavy = bearish positioning proxy.
    Returns number of technical_signals rows updated.
    """
    # Same bug class as compute_delivery_trend() above (fixed 2026-08-13, see its own comment):
    # raw date.today() as the exact-match technical_signals.date write target fails silently
    # (0 rows) whenever "today" doesn't match a real grid row -- weekends, or a slow
    # ml-daily-ops run that crosses midnight IST. The correct floor is this function's OWN
    # source table's actual latest date, not the wall clock.
    cur = con.cursor()
    cur.execute(translate("SELECT MAX(date) FROM nt_fno_dashboard"))
    row = cur.fetchone()
    today = (row[0] if row else None) or date.today().isoformat()

    cur.execute("""
            UPDATE technical_signals ts
            SET short_interest_proxy = sub.proxy
            FROM (
                SELECT
                    symbol,
                    total_puts_oi / NULLIF(total_calls_oi + total_puts_oi, 0) AS proxy
                FROM nt_fno_dashboard
                WHERE date = (SELECT MAX(date) FROM nt_fno_dashboard)
                  AND total_calls_oi IS NOT NULL
                  AND total_puts_oi  IS NOT NULL
            ) sub
            WHERE ts.symbol = sub.symbol
              AND ts.date   = :today
        """, {"today": today})

    updated = cur.rowcount
    con.commit()
    return updated


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Delivery trend, bulk/block deals, and short interest proxy features"
    )
    parser.add_argument("--delivery", action="store_true", help="Only compute delivery trend")
    parser.add_argument("--deals",    action="store_true", help="Only fetch bulk/block deals")
    parser.add_argument("--short",    action="store_true", help="Only compute short interest proxy")
    args = parser.parse_args()

    # No flags = run all
    run_all = not (args.delivery or args.deals or args.short)

    con = connect()
    ensure_schema(con)

    delivery_count = 0
    deals_today    = 0
    short_count    = 0

    if run_all or args.delivery:
        delivery_count = compute_delivery_trend(con)
        print(f"[DeliveryTrend] Delivery trend computed: {delivery_count} stocks updated")

    if run_all or args.deals:
        deals_today, deal_signals = run_deals(con)
        print(f"[DeliveryTrend] Bulk/block deals today: {deals_today}. "
              f"Signal flags updated: {deal_signals} stocks")

    if run_all or args.short:
        short_count = compute_short_proxy(con)
        print(f"[DeliveryTrend] Short proxy: {short_count} F&O stocks updated")

    con.close()
    print(
        f"[DeliveryTrend] Done. "
        f"Delivery trend: {delivery_count} stocks. "
        f"Bulk deals today: {deals_today}. "
        f"Short proxy: {short_count} F&O stocks updated."
    )


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
