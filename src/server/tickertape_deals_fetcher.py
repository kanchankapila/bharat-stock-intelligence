#!/usr/bin/env python3
"""
Bulk/block deals with % -of-float, from Tickertape.

WHY THIS EXISTS
---------------
`block_deal_fetcher.py` already pulls NSE's own bulk/block feed, but NSE gives quantity and
price only. Both are ABSOLUTE, so neither is comparable across the cross-section: a Rs 12 cr
purchase is a control transaction in a microcap and a rounding error in Reliance. Normalising
it needs a reliable float figure per symbol, which this platform does not hold.

Tickertape publishes the same deals with `pctTransacted` -- the deal as a percentage of float,
already normalised at source. The 2026-07-31 endpoint-corpus audit called it the most ML-ready
field in a 919-URL corpus, and it is the reason this fetcher exists. It also carries the
counterparty name and the side, which matter because a promoter-group buy and an exiting-PE
sell are opposite events that look identical once reduced to a net quantity.

    https://analyze.api.tickertape.in/stocks/deals?count=N&offset=M

Live-verified 2026-07-31: 659,720 deals available, all 13 fields non-null on every sampled
row, `ticker` is a real NSE symbol (XTRANET), `pctTransacted` a real float (2.4009).

ENDPOINT QUIRKS -- verified, do not "fix" these
-----------------------------------------------
* `type=block` and `type=bulk` are IGNORED. Both return the identical mixed set. Use the
  per-row `category` field, never the query param.
* The feed is NOT only bulk/block. Over 1,000 live rows the categories were Bulk, Block, and
  ten flavours of insider transaction ('Insider - Promoter', 'Insider - KMP',
  'Insider - Designated Person', ...). This fetcher keeps ONLY Bulk/Block, because
  `block_deals` is shared with `block_deal_fetcher.py`'s NSE bulk/block rows and silently
  mixing insider filings into it would change what the table means for every existing reader.
  Worth a follow-up though: those insider rows carry `pctTransacted`, which the platform's own
  `insider_transactions_fetcher.py` (NSE PIT filings) does NOT provide -- so the same endpoint
  could materially improve insider features, in that fetcher's table rather than this one.
* `offset` paginates; `skip` is silently ignored and returns page 1 again, so a loop built on
  `skip` would re-insert the first page forever while looking like it was making progress.

AS-OF DISCIPLINE
----------------
`date` here is the trade date, which for bulk/block deals is also the DISCLOSURE date --
exchanges publish them post-close the same day. So unlike quarterly ownership data this needs
no publication-lag offset (cf. earnings_beat_features.py's PERIOD_LAG_DAYS). Deals are still
only known AFTER that session closes, so any consumer must join them strictly as-of the NEXT
session; that is the caller's job, and `as_of.py` is the helper for it.

Run:
  python tickertape_deals_fetcher.py --pages 5        # recent deals
  python tickertape_deals_fetcher.py --pages 200      # deeper history
"""
import argparse
import datetime
import sys

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get

API = "https://analyze.api.tickertape.in/stocks/deals"
PAGE_SIZE = 200
SOURCE = "tickertape"
# The only categories that belong in block_deals. Everything else this endpoint returns is
# an insider filing (see the module docstring).
DEAL_CATEGORIES = {"Bulk", "Block"}
# Everything else this endpoint returns is an insider filing, by relationship type. These go
# to insider_trades (--insider), NOT block_deals -- with pctTransacted, which NSE's own PIT
# feed does not provide, so insider materiality becomes measurable rather than just directional.
INSIDER_PREFIX = "Insider"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.tickertape.in/",
}


def _log(m):
    print(f"[TTDeals] {m}", flush=True)


def fetch_page(session: requests.Session, offset: int, count: int = PAGE_SIZE) -> list:
    """One page of deals. The ONLY fetch path -- tests call this, never a reimplementation."""
    resp = retry_get(session, API, params={"count": count, "offset": offset}, timeout=30)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return ((payload.get("data") or {}).get("items")) or []


def parse_deal(raw: dict) -> dict | None:
    """One API row -> one block_deals row, or None if it is not usable.

    A deal with no ticker or no date cannot be joined to anything, and a deal whose
    pctTransacted is absent loses the only reason this source was chosen -- but the row is
    still kept in that case, because quantity/value remain useful and dropping it would make
    this fetcher's coverage silently worse than NSE's.
    """
    ticker = (raw.get("ticker") or "").strip().upper()
    date = (raw.get("date") or "")[:10]
    if not ticker or not date:
        return None

    # Keep bulk/block only -- see the module docstring on the insider categories.
    category = (raw.get("category") or "").strip()
    if category not in DEAL_CATEGORIES:
        return None
    try:
        datetime.date.fromisoformat(date)
    except ValueError:
        return None

    def num(k):
        v = raw.get(k)
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return None if f != f else f   # NaN -> None; a NaN passes every coverage check

    value = num("value")
    deal_id = raw.get("_id")
    if not deal_id:
        return None

    return {
        # Namespaced so it can never collide with NSE's own ids in the shared table.
        "id": f"tt:{deal_id}",
        "symbol": ticker,
        "date": date,
        "session": None,
        "qty": int(num("qty")) if num("qty") is not None else None,
        "price": num("avgPrice"),
        "value_cr": (value / 1e7) if value is not None else None,   # rupees -> crore
        "pct_transacted": num("pctTransacted"),
        "client_name": (raw.get("client") or "").strip() or None,
        "trade_type": (raw.get("tradeType") or "").strip().lower() or None,
        "category": category,
        "source": SOURCE,
    }


COLS = ["id", "symbol", "date", "session", "qty", "price", "value_cr",
        "pct_transacted", "client_name", "trade_type", "category", "source"]

INSIDER_COLS = ["id", "symbol", "acquirerName", "category", "typeOfTransaction",
                "quantity", "valueInr", "date", "date_iso", "pct_transacted", "source"]

# insider_trades.id is a BIGINT primary key with no default (existing NSE rows occupy 9..46k),
# so a "tt:" string key like block_deals uses will not fit. Derive a deterministic id from the
# low 48 bits of Tickertape's ObjectId and offset it far above the NSE range: same filing ->
# same id on every run, so re-running is an idempotent upsert rather than a duplicate insert,
# and the two sources can never collide. 48 bits over a few hundred thousand rows makes an
# internal collision vanishingly unlikely, and ON CONFLICT would make one an overwrite of the
# same filing rather than corruption.
INSIDER_ID_OFFSET = 1_000_000_000_000_000


def _insider_id(object_id: str) -> int | None:
    try:
        return INSIDER_ID_OFFSET + int(str(object_id)[-12:], 16)
    except (TypeError, ValueError):
        return None


def parse_insider(raw: dict) -> dict | None:
    """One API row -> one insider_trades row, or None if it is not an insider filing.

    Maps onto insider_trades' existing NSE-PIT column names so both sources coexist in one
    table. date_iso is written directly: the legacy `date` column holds NSE's display format
    ("05 Apr, 2022") on 46,194 of 46,198 rows, and insider_features.py reads date_iso.
    """
    category = (raw.get("category") or "").strip()
    if not category.startswith(INSIDER_PREFIX):
        return None
    ticker = (raw.get("ticker") or "").strip().upper()
    date = (raw.get("date") or "")[:10]
    deal_id = raw.get("_id")
    if not ticker or not date or not deal_id:
        return None
    try:
        datetime.date.fromisoformat(date)
    except ValueError:
        return None

    def num(k):
        try:
            f = float(raw.get(k))
        except (TypeError, ValueError):
            return None
        return None if f != f else f

    side = (raw.get("tradeType") or "").strip().lower()
    rid = _insider_id(deal_id)
    if rid is None:
        return None
    return {
        "id": rid,
        "symbol": ticker,
        "acquirerName": (raw.get("client") or "").strip() or None,
        "category": category,
        # insider_features.py matches on BUY/SELL uppercase.
        "typeOfTransaction": "BUY" if side == "buy" else ("SELL" if side == "sell" else None),
        "quantity": num("qty"),
        "valueInr": num("value"),
        "date": date,
        "date_iso": date,
        "pct_transacted": num("pctTransacted"),
        "source": SOURCE,
    }


def ensure_insider_schema(conn: ConnWrapper) -> None:
    for col, typ in [("date_iso", "TEXT"), ("pct_transacted", "REAL"), ("source", "TEXT")]:
        try:
            conn.execute(f"ALTER TABLE insider_trades ADD COLUMN {col} {typ}")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass


def store_insider(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(INSIDER_COLS))
    quoted = ", ".join(f'"{c}"' for c in INSIDER_COLS)
    updates = ", ".join(f'"{c}"=excluded."{c}"' for c in INSIDER_COLS[1:])
    sql = (f"INSERT INTO insider_trades ({quoted}) VALUES ({ph}) "
           f"ON CONFLICT (id) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in INSIDER_COLS))
        n += 1
    conn.commit()
    return n


def ensure_schema(conn: ConnWrapper) -> None:
    """node-pg-migrate owns the production migration; this keeps throwaway/SQLite test DBs
    and a fresh dev box working without one."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS block_deals (
            id TEXT PRIMARY KEY, symbol TEXT NOT NULL, date TEXT NOT NULL, session TEXT,
            qty BIGINT, price REAL, value_cr REAL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    for col, typ in [("pct_transacted", "REAL"), ("client_name", "TEXT"),
                     ("trade_type", "TEXT"), ("category", "TEXT"), ("source", "TEXT")]:
        try:
            conn.execute(f"ALTER TABLE block_deals ADD COLUMN {col} {typ}")
            conn.commit()
        except Exception:
            # Already present. Postgres poisons the transaction on a failed statement, so
            # every later query would die with InFailedSqlTransaction -- roll back.
            try:
                conn.rollback()
            except Exception:
                pass
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO block_deals ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (id) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def run(pages: int = 5, insider: bool = False) -> int:
    session = requests.Session()
    session.headers.update(HEADERS)

    conn = connect()
    try:
        ensure_schema(conn)
        if insider:
            ensure_insider_schema(conn)
        total_stored = total_seen = skipped = insider_stored = 0
        for p in range(pages):
            items = fetch_page(session, offset=p * PAGE_SIZE)
            if not items:
                _log(f"page {p + 1}: empty, stopping early")
                break
            total_seen += len(items)
            rows = [d for d in (parse_deal(i) for i in items) if d is not None]
            skipped += len(items) - len(rows)
            total_stored += store(conn, rows)
            if insider:
                irows = [d for d in (parse_insider(i) for i in items) if d is not None]
                insider_stored += store_insider(conn, irows)
        row = conn.execute(
            "SELECT COUNT(*), COUNT(pct_transacted) FROM block_deals WHERE source = ?",
            (SOURCE,),
        ).fetchone()
        held, with_pct = (row[0], row[1]) if row else (0, 0)
        # Report pct_transacted coverage explicitly: it is the whole reason this source was
        # added, so a run that stores rows without it is a silent failure, not a success.
        _log(f"fetched {total_seen} deals, stored {total_stored}, skipped {skipped} unusable; "
             f"table now holds {held} {SOURCE} rows, {with_pct} with pct_transacted")
        if insider:
            _log(f"insider_trades: {insider_stored} filings upserted with pct_transacted")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return 0 if total_stored else 1


def main():
    ap = argparse.ArgumentParser(description="Tickertape bulk/block deals with % of float")
    ap.add_argument("--pages", type=int, default=5,
                    help=f"pages of {PAGE_SIZE} to pull (newest first)")
    ap.add_argument("--insider", action="store_true",
                    help="also write the feed's insider filings to insider_trades")
    args = ap.parse_args()
    sys.exit(run(pages=args.pages, insider=args.insider))


if __name__ == "__main__":
    main()
