#!/usr/bin/env python3
"""
Trendlyne's real-time corporate-event feed -- pre-classified events (order wins, margin
moves, estimate beats/misses, target upgrades, block deals, IPOs, management changes, ...),
one row per event, already resolved to an NSE ticker.

WHY THIS EXISTS
----------------
Promoted from `endpoint_registry.py`'s `CURATED_EXTRA_ENDPOINTS` (`trendlyne_market_insight`,
added 2026-07-30), archived raw into `extra_endpoint_responses` (symbol='MARKET') and never
parsed. Originally left that way in the 2026-08-15 registry-backlog pass, on the assumption
this needed real NLP dedup work like a generic headline feed -- **that assessment was wrong,
corrected same day after actually inspecting the payload**: unlike `news_sentiment_items`'s
sources (Google News, LiveMint, etc. -- raw headlines needing entity tagging + sentiment
classification), this feed arrives PRE-CLASSIFIED. Every row carries a `label` from a fixed,
Trendlyne-curated taxonomy (55 distinct values sampled: "Order Win", "Margin Decline",
"Estimates Beat/Miss", "Target Upgrade", "Block Deal", "IPO Listing", "CEO Appointment", ...)
and a real `NSEcode` -- no entity resolution or sentiment inference needed at all. Trendlyne is
not an existing `news_sentiment_items` source (checked live 2026-08-15: 0 of that table's 30
distinct sources is Trendlyne), so this is genuinely new event coverage, not a duplicate.

    https://trendlyne.com/equity/api/market-insight/

Live-verified 2026-08-15: 200 rows (API's own hard cap -- "Market Insights has been curtailed
to 200"), spanning ~10 days (2026-08-04 to 2026-08-14) on an unparameterized call, all 200
distinct notifications, `label` and `NSEcode` populated on every row. **95.5% NSEcode match
rate against `nse_stocks`** (191/200) -- the 9 misses are explainable, not silently dropped
(logged): 6 are `label='IPO Listing'` events for brand-new listings not yet synced into
`nse_stocks` (LEAPIND, TECHNOCRAF, ARDEE, JNPR, MVELECTRO, MANIPALHOS), 1 is an InvIT trust
(`INDIGRID` -- not a regular equity), 1 is a raw numeric code instead of a ticker (a single
malformed upstream row, GUJENERGY's sibling -- kept out per data-sources.md, never guessed at).

**This is descriptive event tagging, not a measured factor.** `label`'s apparent bullish/
bearish lean (Order Win/Estimates Beat read positive, Margin Decline/Estimates Miss read
negative) is exactly the shape `measurement.md` warns about for screener `signal_bias` --
do not hand-classify `label` into a polarity and treat it as validated sentiment without a real
factor_backtest.py-style measurement against realized returns first. `nColor` was 'neutral' on
100% of the live sample; whether it ever takes another value is unconfirmed.

ENDPOINT QUIRKS -- verified, do not "fix" these
-----------------------------------------------
* No usable per-event id: `screenRedirectUrl`'s `/posts/{id}/` numeric suffix is only present
  on 134/200 (67%) sampled rows -- the rest route through `/equity/`, `/latest-news/`, or
  `/equity/consensus-estimates/` paths carrying Trendlyne's *company* id, not a post id. Rather
  than two id schemes, the row key here is the composite (NSEcode, label, timeStamp) -- a
  specific event type for a specific stock at a specific minute is a stable natural key, and
  the live sample confirms 200/200 distinct on this basis.
* `timeStamp` is a human-formatted string ("14 Aug, 2026  3:31 PM (IST)", double space before
  the hour) -- parsed here into a real date/timestamp; unparseable rows are dropped rather than
  stored with a fabricated date.
* The endpoint has no visible pagination/date-range params on this call shape -- "curtailed to
  200" is a hard cap on an unparameterized request. A daily fetch captures the full available
  window each run (upsert handles the overlap); deeper backfill was not attempted here.

Run:
  python trendlyne_market_insight_fetcher.py
"""
import sys
from datetime import datetime

import requests

from db_compat import connect, ConnWrapper, query_all

API = "https://trendlyne.com/equity/api/market-insight/"
SOURCE = "trendlyne"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def fetch_insights() -> list:
    """The ONLY fetch path -- tests call this, never a reimplementation."""
    r = requests.get(API, headers=HEADERS, timeout=20)
    r.raise_for_status()
    payload = r.json()
    if not isinstance(payload, dict):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    body = payload.get("body") or {}
    if not isinstance(body, dict):
        raise ValueError(f"unexpected body envelope: {str(body)[:200]}")
    return body.get("marketInsights") or []


def _parse_timestamp(raw: str) -> str | None:
    """'14 Aug, 2026  3:31 PM (IST)' -> '2026-08-14 15:31:00'. IST is a fixed +05:30 offset
    this platform doesn't otherwise track timezone-aware, so stored as a naive IST-local
    string, same convention as this feed's own timeStamp label."""
    if not raw:
        return None
    cleaned = " ".join(raw.replace("(IST)", "").split())  # collapse the double space
    try:
        dt = datetime.strptime(cleaned, "%d %b, %Y %I:%M %p")
    except ValueError:
        return None
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def parse_insight(raw: dict, universe: set) -> dict | None:
    """One API row -> one trendlyne_market_insights row, or None if not usable."""
    symbol = (raw.get("NSEcode") or "").strip().upper()
    if not symbol or symbol not in universe:
        return None
    label = (raw.get("label") or "").strip()
    parsed_ts = _parse_timestamp(raw.get("timeStamp") or "")
    if not label or not parsed_ts:
        return None

    return {
        "id": f"trendlyne:{symbol}:{label}:{parsed_ts}",
        "symbol": symbol,
        "label": label,
        "notification": (raw.get("notification") or "").strip() or None,
        "event_time": parsed_ts,
        "n_color": (raw.get("nColor") or "").strip() or None,
        "source_url": (raw.get("completeUrl") or raw.get("url") or "").strip() or None,
        "source": SOURCE,
    }


COLS = ["id", "symbol", "label", "notification", "event_time", "n_color", "source_url", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_market_insights (
            id TEXT PRIMARY KEY, symbol TEXT NOT NULL, label TEXT NOT NULL,
            notification TEXT, event_time TEXT NOT NULL, n_color TEXT, source_url TEXT,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO trendlyne_market_insights ({', '.join(COLS)}) VALUES ({ph}) "
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
        raw_rows = fetch_insights()
        rows = [r for r in (parse_insight(i, universe) for i in raw_rows) if r is not None]
        n = store(conn, rows)
        dropped = len(raw_rows) - len(rows)
        print(f"[TLMarketInsight] {len(raw_rows)} seen, {n} stored, {dropped} dropped "
              f"(unresolved symbol/unparseable timestamp)", flush=True)
        return n
    finally:
        conn.close()


def main() -> int:
    n = run()
    if n == 0:
        print("[TLMarketInsight] nothing stored", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
