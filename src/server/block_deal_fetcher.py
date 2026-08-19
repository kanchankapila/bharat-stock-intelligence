#!/usr/bin/env python3
"""
Block Deal Fetcher (NSE Live + Historical)
==========================================
Fetches block deals from NSE's live API and stores them per symbol per day.
Block deals = large institutional trades executed in a dedicated session before
regular trading hours. They signal conviction buys/sells by big players.

ML features:
  block_deal_buy_qty   → institutional accumulation signal
  block_deal_sell_qty  → institutional distribution signal
  block_deal_net_qty   → net institutional direction (buy - sell)
  block_deal_value_cr  → transaction size in crores (size = conviction)

Sources:
  Live:       https://www.nseindia.com/api/block-deal
  Historical: https://www.nseindia.com/api/historical/block-deals?from=DD-Mon-YYYY&to=DD-Mon-YYYY
              (accessible after priming cookies on NSE homepage)

Writes to:
  block_deals (id, symbol, date, session, qty, price, value_cr, client_type)
  stock_block_deal_daily (symbol, date, buy_qty, sell_qty, net_qty, total_value_cr)
  technical_signals.block_deal_net_qty, .block_deal_value_cr (for ML)

Run:
  python block_deal_fetcher.py              # today's live deals
  python block_deal_fetcher.py --days 30    # backfill 30 calendar days
  python block_deal_fetcher.py --date 2026-06-24
"""

import argparse
import time
from datetime import date, datetime, timedelta

import requests

from as_of import logical_trading_date, trading_days_back
from db_compat import connect
from fetch_utils import retry_get

LIVE_URL  = "https://www.nseindia.com/api/block-deal"
HIST_URL  = "https://www.nseindia.com/api/historical/block-deals"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/market-data/block-deal",
}

RATE_LIMIT_SEC = 1.5


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS block_deals (
            id            TEXT PRIMARY KEY,
            symbol        TEXT NOT NULL,
            date          TEXT NOT NULL,
            session       TEXT,
            qty           BIGINT,
            price         REAL,
            value_cr      REAL,
            fetched_at    TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_bd_symbol_date ON block_deals(symbol, date DESC)
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_block_deal_daily (
            symbol         TEXT NOT NULL,
            date           TEXT NOT NULL,
            buy_qty        BIGINT DEFAULT 0,
            sell_qty       BIGINT DEFAULT 0,
            net_qty        BIGINT DEFAULT 0,
            total_value_cr REAL DEFAULT 0,
            deal_count     INTEGER DEFAULT 0,
            fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_sbdd_date ON stock_block_deal_daily(date)
    """)
    con.commit()  # commit tables/indexes before ALTER
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN block_deal_net_qty   BIGINT",
        "ALTER TABLE technical_signals ADD COLUMN block_deal_value_cr  REAL",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


def _prime_session(session: requests.Session) -> None:
    """NSE requires a cookie from the homepage before API calls work."""
    try:
        session.get("https://www.nseindia.com/", timeout=10)
        time.sleep(0.5)
    except Exception:
        pass


def fetch_live(session: requests.Session) -> list[dict]:
    """Fetch today's block deals from the live endpoint."""
    try:
        r = retry_get(session, LIVE_URL, timeout=10)
        data = r.json()
        return data.get("data", [])
    except Exception as e:
        print(f"[Block] Live fetch error after retries: {e}")
        return []


def fetch_historical(trade_date: date, session: requests.Session) -> list[dict]:
    """Fetch historical block deals for a single date."""
    date_str = trade_date.strftime("%d-%b-%Y")
    try:
        r = retry_get(session, HIST_URL, params={"from": date_str, "to": date_str}, timeout=15)
    except Exception as e:
        status = getattr(getattr(e, 'response', None), 'status_code', None)
        if status in (401, 403):
            print(f"[Block] {trade_date}: auth required for historical API")
        else:
            print(f"[Block] {trade_date}: historical fetch error after retries: {e}")
        return []
    try:
        data = r.json()
        # Historical response: {"data": [...]} or directly [...]
        if isinstance(data, dict):
            return data.get("data", [])
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"[Block] {trade_date}: historical parse error: {e}")
        return []


def _parse_deal(raw: dict, trade_date: date) -> dict | None:
    """Normalise a raw deal dict from either live or historical endpoint."""
    symbol = (
        raw.get("symbol") or raw.get("Symbol") or raw.get("scrips") or ""
    ).strip().upper()
    if not symbol:
        return None

    qty_raw = raw.get("totalTradedVolume") or raw.get("quantity") or raw.get("Quantity") or 0
    price_raw = raw.get("lastPrice") or raw.get("price") or raw.get("Price") or 0
    session_label = raw.get("session") or raw.get("clientType") or ""
    value_raw = raw.get("totalTradedValue") or 0

    try:
        qty   = int(float(str(qty_raw).replace(",", "")))
        price = float(str(price_raw).replace(",", ""))
        value_cr = float(str(value_raw).replace(",", "")) / 1e7  # paise→cr or units→cr
        if value_cr == 0 and qty > 0 and price > 0:
            value_cr = round(qty * price / 1e7, 4)  # compute from qty × price
    except (ValueError, TypeError):
        return None

    # Determine buy/sell from session label or client type
    is_buy = "buy" in session_label.lower() or "Session 1" in session_label

    return {
        "symbol":       symbol,
        "date":         trade_date.isoformat(),
        "session":      session_label,
        "qty":          qty,
        "price":        price,
        "value_cr":     round(value_cr, 4),
        "is_buy":       is_buy,
    }


def upsert_deals(raw_list: list[dict], trade_date: date, con) -> int:
    if not raw_list:
        return 0

    parsed = [_parse_deal(r, trade_date) for r in raw_list]
    parsed = [p for p in parsed if p is not None]
    if not parsed:
        return 0

    cur = con.cursor()

    # Insert individual deals
    for i, d in enumerate(parsed):
        deal_id = f"{d['symbol']}_{d['date']}_{i}"
        cur.execute("""
            INSERT INTO block_deals (id, symbol, date, session, qty, price, value_cr)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                qty       = excluded.qty,
                price     = excluded.price,
                value_cr  = excluded.value_cr,
                fetched_at = CURRENT_TIMESTAMP
        """, (deal_id, d["symbol"], d["date"], d["session"],
              d["qty"], d["price"], d["value_cr"]))

    # Aggregate per symbol per date
    agg: dict[str, dict] = {}
    for d in parsed:
        sym = d["symbol"]
        if sym not in agg:
            agg[sym] = {"buy_qty": 0, "sell_qty": 0, "total_value_cr": 0.0, "deal_count": 0}
        if d["is_buy"]:
            agg[sym]["buy_qty"] += d["qty"]
        else:
            agg[sym]["sell_qty"] += d["qty"]
        agg[sym]["total_value_cr"] += d["value_cr"]
        agg[sym]["deal_count"] += 1

    for sym, a in agg.items():
        net = a["buy_qty"] - a["sell_qty"]
        cur.execute("""
            INSERT INTO stock_block_deal_daily
                (symbol, date, buy_qty, sell_qty, net_qty, total_value_cr, deal_count)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                buy_qty        = excluded.buy_qty,
                sell_qty       = excluded.sell_qty,
                net_qty        = excluded.net_qty,
                total_value_cr = excluded.total_value_cr,
                deal_count     = excluded.deal_count,
                fetched_at     = CURRENT_TIMESTAMP
        """, (sym, trade_date.isoformat(),
              a["buy_qty"], a["sell_qty"], net, a["total_value_cr"], a["deal_count"]))

    con.commit()
    return len(parsed)


def backfill_technical_signals(today: str, con) -> int:
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals
        SET block_deal_net_qty  = (
            SELECT net_qty FROM stock_block_deal_daily
            WHERE symbol = technical_signals.symbol AND date = ?
            LIMIT 1
        ),
        block_deal_value_cr = (
            SELECT total_value_cr FROM stock_block_deal_daily
            WHERE symbol = technical_signals.symbol AND date = ?
            LIMIT 1
        )
        WHERE date = ?
    """, (today, today, today))
    updated = cur.rowcount
    con.commit()
    return updated


def _calendar_days_back(n: int, conn=None) -> list[date]:
    """Return last n REAL trading sessions INCLUDING today, most recent first.

    Was anchored at today - 1 unconditionally -- with the live-endpoint branch below matching
    "trade_date >= today - 1", that made the --days 1 default (a single date: yesterday) fetch
    from the LIVE endpoint (which can only ever return TODAY's session) and stamp the result
    with yesterday's date. Live-confirmed 2026-08-14 (fetcher-accuracy-review): byte-identical
    deals for BIOCON/METROPOLIS/SUDEEPPHRM/THYROCARE/URBANCO filed under two adjacent dates --
    one real capture mislabeled a day early, the other correct if NSE's feed still showed it the
    next day. Anchoring at today (not today-1) plus the tightened live-endpoint condition below
    fixes both the --days 1 case and the corresponding slot in any larger --days N backfill.

    "Today" is `as_of.logical_trading_date()`, not the bare calendar date: this fetcher is one
    of ~30 sequential steps inside ml-daily-ops, which regularly finishes after midnight IST
    (see logical_trading_date's own docstring). A bare date.today() run at e.g. 00:30 IST would
    anchor on the NEXT calendar day, route to fetch_live() (which only ever reflects that day's
    still-empty pre-market session) and mislabel the day that just closed -- the same failure
    shape this function was written to fix, from the opposite direction.

    The rest of the window used to be a hand-rolled "step back a day, keep it if weekday() < 5"
    walk -- holiday-blind, so --days 90 silently covered fewer than 90 real sessions whenever a
    holiday fell in range (found 2026-08-19, /temporal-correctness-audit). as_of.trading_days_back()
    is the same fix already applied to delivery_volume_fetcher.py/fno_rollover_fetcher.py for
    this exact shape; it reads the real session list from stock_ohlcv and excludes today itself,
    so today is prepended separately here.
    """
    if n <= 0:
        return []
    today = date.fromisoformat(logical_trading_date())
    # logical_trading_date() should always resolve to a real trading session; this defensive
    # walk-to-weekday is only for that assumption ever being wrong (mirrors the pre-fix code's
    # own weekday() < 5 guard). The part that actually needed the real trading calendar was the
    # N-1 days behind it, which trading_days_back() now supplies.
    while today.weekday() >= 5:
        today -= timedelta(days=1)
    days = [today]
    if n > 1:
        days.extend(trading_days_back(n - 1, conn))
    return days[:n]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=1,
                        help="Backfill last N trading days (default: 1 = today/yesterday live)")
    parser.add_argument("--date", type=str, default=None,
                        help="Fetch a specific date (YYYY-MM-DD)")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    session = requests.Session()
    session.headers.update(HEADERS)
    _prime_session(session)

    if args.date:
        dates = [datetime.strptime(args.date, "%Y-%m-%d").date()]
    else:
        dates = _calendar_days_back(args.days, con)

    today = date.fromisoformat(logical_trading_date())
    total = 0

    for i, trade_date in enumerate(dates):
        print(f"[Block] Fetching {trade_date} ({i+1}/{len(dates)})…")

        if trade_date >= today:
            # Live endpoint only ever reflects TODAY's session -- using it for any earlier date
            # (yesterday included) mislabels today's deals with that earlier date. Everything
            # before today must come from the historical endpoint instead.
            raw_list = fetch_live(session)
        else:
            raw_list = fetch_historical(trade_date, session)

        saved = upsert_deals(raw_list, trade_date, con)
        print(f"[Block] {trade_date}: {saved} deals saved")
        total += saved

        if i < len(dates) - 1:
            time.sleep(RATE_LIMIT_SEC)

    most_recent = dates[0].isoformat() if dates else None
    if most_recent:
        updated = backfill_technical_signals(most_recent, con)
        print(f"[Block] Updated {updated} technical_signals rows for {most_recent}")

    print(f"[Block] Done. Total deals: {total}")
    con.close()


if __name__ == "__main__":
    main()
