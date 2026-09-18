#!/usr/bin/env python3
"""MoneyControl per-symbol BLOCK-DEAL HISTORY -> block_deals.

WHY THIS EXISTS
---------------
AF-20260914-02. NSE's historical block/bulk-deal ranges are down and have stayed down:
`/api/historical/block-deals` answered **503 on 30 of 30 dates** on 2026-09-17 and again on
2026-09-18, while `/api/block-deal` (today only) answers 200. So `block_deals` could be kept
current but never backfilled, and its composition showed it -- 8,849 of 8,921 rows came from the
tickertape crawl, which is small/mid-cap heavy, and **RELIANCE / TCS / INFY / HDFCBANK held ZERO
rows**. `feature_store.block_deal_*` was therefore structurally empty for exactly the most liquid
names, which is not a coverage gap so much as a silent selection bias in any model reading it.

Per `data-sources.md`'s mandatory sequence, the discovery registry was queried before concluding
anything: `market_endpoint_registry` returns this route, and probing it live found a per-symbol
PAGINATED history going back years. RELIANCE walks 4 pages to 32 deals reaching 06-Nov-2024.

ENDPOINT
--------
    GET https://api.moneycontrol.com/mcapi/v1/extdata/mc-block-data?scId=<mcsymbol>&page=<n>

`auth_type: NONE`. Minimum headers determined by isolating one at a time (the discipline in
`data-sources.md`, and the one this repo keeps re-learning): **User-Agent + Referer only** -- no
token, no cookie, no `sec-fetch-*`. Do not add headers speculatively; on a sibling vendor an
extra `sec-fetch-site` value LOWERED access from 200 to 403.

Pagination contract: `data.seemore` is `"Y"` while more pages exist and `"N"` on the last one.
Walk until it is not `"Y"`; never infer the end from an empty page alone.

IDENTIFIERS
-----------
`scId` is the MoneyControl `mcsymbol`. It is resolved FORWARD (symbol -> mcsymbol) on purpose:
the reverse direction is ambiguous -- 62 codes map to more than one NSE symbol (AF-20260918-02,
see `mc_symbol_map.py`) -- so building a reverse map here would misattribute deals. Going forward
from the symbol we are already iterating cannot.

TWO VENDOR SHAPES THAT ARE DOCUMENTED TRAPS, HANDLED HERE
---------------------------------------------------------
1. `datetime` is a DISPLAY string, "24 Jun, 2026", not ISO. `recurring-bugs.md` records a table
   (`insider_trades`) where a display-format date column sat beside a parsed one and poisoned
   every ad-hoc `max(date)` for months. Parsed to a real DATE at the boundary; a row whose date
   will not parse is SKIPPED, never stored as text.
2. `type` is mixed case -- measured values are `"purchase"` and `"Sell"`. That is the enum-casing
   class (`recurring-bugs.md`): two spellings of one value defeat `IN`/`NOT IN` and, on a
   composite key, survive as separate rows forever. Normalised to BUY/SELL, and an unrecognised
   value is skipped rather than guessed.

WRITES
------
`block_deals` with `source='moneycontrol'`, upserting on the existing `id` primary key. `id` is a
content hash prefixed `mcbd_`, NOT the `{symbol}_{date}_{i}` positional scheme the NSE fetcher
uses: a positional index is not stable across re-fetches (the vendor may reorder or insert), so
re-running would duplicate. A hash makes this idempotent.

Run:
    python mc_block_deal_history_fetcher.py --limit 200      # top 200 by market cap
    python mc_block_deal_history_fetcher.py --symbol RELIANCE
    python mc_block_deal_history_fetcher.py --limit 50 --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime

import requests

from db_compat import connect

BASE = "https://api.moneycontrol.com/mcapi/v1/extdata/mc-block-data"
SOURCE = "moneycontrol"
# Minimum set, determined by isolation. See the module docstring before adding to this.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": "https://www.moneycontrol.com/",
}
RATE_LIMIT_SEC = 0.3
MAX_PAGES = 40          # a hard stop so a vendor that never sets seemore='N' cannot spin forever
REQUEST_TIMEOUT = 20

# Measured vendor spellings, 2026-09-18. Anything outside this map is skipped, not guessed.
TRADE_TYPES = {
    "purchase": "BUY",
    "buy": "BUY",
    "sell": "SELL",
    "sale": "SELL",
}


def _log(msg: str) -> None:
    print(f"[MCBlockDeal] {msg}")


def parse_deal_date(raw: str):
    """'24 Jun, 2026' -> date. Returns None if it will not parse (caller skips the row).

    Never fall back to storing the raw string: a display-format date beside real dates is the
    `insider_trades` trap in `recurring-bugs.md` -- it sorts lexically and silently poisons every
    MIN/MAX taken on the column.
    """
    if not raw:
        return None
    for fmt in ("%d %b, %Y", "%d %b %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(raw).strip(), fmt).date()
        except ValueError:
            continue
    return None


def normalize_trade_type(raw):
    """'purchase'/'Sell' -> 'BUY'/'SELL'. None for anything unrecognised."""
    if raw is None:
        return None
    return TRADE_TYPES.get(str(raw).strip().lower())


def _num(val):
    """Vendor numerics arrive as str or number; non-finite/garbage becomes None, never 0.0.

    Writing a sentinel 0.0 for 'missing' is invisible to every coverage check and poisons any
    measurement built on the column (`recurring-bugs.md`, sentinel-instead-of-NULL).
    """
    if val is None:
        return None
    try:
        f = float(str(val).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def deal_id(symbol: str, d, client: str, ttype: str, qty, price) -> str:
    """Content hash, so a re-fetch updates the same row instead of duplicating it."""
    key = f"{SOURCE}|{symbol}|{d.isoformat()}|{(client or '').strip().lower()}|{ttype}|{qty}|{price}"
    return "mcbd_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:24]


def fetch_symbol_pages(session: requests.Session, mcsymbol: str) -> tuple[list[dict], str | None]:
    """Walk pages until seemore != 'Y'. Returns (raw_rows, error)."""
    rows: list[dict] = []
    for page in range(1, MAX_PAGES + 1):
        try:
            r = session.get(BASE, params={"scId": mcsymbol, "page": page},
                            headers=HEADERS, timeout=REQUEST_TIMEOUT)
        except Exception as e:                                  # network-level
            return rows, f"request failed on page {page}: {e}"
        if r.status_code != 200:
            return rows, f"HTTP {r.status_code} on page {page}"
        try:
            body = (r.json() or {}).get("data") or {}
        except (ValueError, json.JSONDecodeError):
            return rows, f"unparseable body on page {page}"
        page_rows = body.get("stock_detail") or []
        rows.extend(page_rows)
        if body.get("seemore") != "Y":
            break
        time.sleep(RATE_LIMIT_SEC)
    return rows, None


def parse_rows(symbol: str, raw_rows: list[dict]) -> list[dict]:
    out = []
    for r in raw_rows:
        d = parse_deal_date(r.get("datetime"))
        ttype = normalize_trade_type(r.get("type"))
        if d is None or ttype is None:
            continue
        qty = _num(r.get("quantity"))
        price = _num(r.get("price"))
        if qty is None or price is None:
            continue
        client = (r.get("title") or "").strip() or None
        value_cr = round(qty * price / 1e7, 4)
        out.append({
            "id": deal_id(symbol, d, client or "", ttype, int(qty), price),
            "symbol": symbol,
            "date": d.isoformat(),
            "qty": int(qty),
            "price": price,
            "value_cr": value_cr,
            "pct_transacted": _num(r.get("perTraded")),
            "client_name": client,
            "trade_type": ttype,
            "category": "block",
            "source": SOURCE,
        })
    return out


def load_universe(conn, symbol_filter: str | None, limit: int) -> list[tuple[str, str]]:
    """(symbol, mcsymbol) pairs. FORWARD direction only -- see the module docstring."""
    if symbol_filter:
        rows = conn.execute(
            "SELECT symbol, mcsymbol FROM nse_stocks "
            "WHERE upper(symbol) = ? AND mcsymbol IS NOT NULL AND mcsymbol != ''",
            (symbol_filter.upper(),)).fetchall()
    else:
        rows = conn.execute(
            "SELECT symbol, mcsymbol FROM nse_stocks "
            "WHERE status = 'ACTIVE' AND mcsymbol IS NOT NULL AND mcsymbol != '' "
            "AND market_cap IS NOT NULL ORDER BY market_cap DESC LIMIT ?",
            (limit,)).fetchall()
    out = []
    for r in rows:
        try:
            out.append((r["symbol"], r["mcsymbol"]))
        except (TypeError, KeyError, IndexError):
            out.append((r[0], r[1]))
    return out


def store(conn, deals: list[dict]) -> int:
    n = 0
    for d in deals:
        conn.execute("""
            INSERT INTO block_deals
                (id, symbol, date, qty, price, value_cr, pct_transacted,
                 client_name, trade_type, category, source, fetched_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                qty            = excluded.qty,
                price          = excluded.price,
                value_cr       = excluded.value_cr,
                pct_transacted = excluded.pct_transacted,
                client_name    = excluded.client_name,
                trade_type     = excluded.trade_type,
                category       = excluded.category,
                source         = excluded.source,
                fetched_at     = excluded.fetched_at
        """, (d["id"], d["symbol"], d["date"], d["qty"], d["price"], d["value_cr"],
              d["pct_transacted"], d["client_name"], d["trade_type"], d["category"],
              d["source"], datetime.utcnow().isoformat()))
        n += 1
    return n


def run(symbol_filter: str | None = None, limit: int = 200, dry_run: bool = False) -> dict:
    conn = connect()
    session = requests.Session()
    stats = {"symbols": 0, "with_deals": 0, "deals": 0, "stored": 0, "errors": 0}
    try:
        universe = load_universe(conn, symbol_filter, limit)
        if not universe:
            print("[MCBlockDeal] empty universe -- nothing to do (check nse_stocks.mcsymbol)",
                  file=sys.stderr)
            return stats
        _log(f"walking block-deal history for {len(universe)} symbols...")
        for symbol, mcsymbol in universe:
            stats["symbols"] += 1
            raw, err = fetch_symbol_pages(session, mcsymbol)
            if err:
                stats["errors"] += 1
                print(f"[MCBlockDeal] {symbol} ({mcsymbol}): {err}", file=sys.stderr)
                continue
            deals = parse_rows(symbol, raw)
            if deals:
                stats["with_deals"] += 1
                stats["deals"] += len(deals)
                if not dry_run:
                    stats["stored"] += store(conn, deals)
            time.sleep(RATE_LIMIT_SEC)
        if not dry_run:
            conn.commit()
        _log(f"done: {stats['symbols']} symbols, {stats['with_deals']} with deals, "
             f"{stats['deals']} parsed, {stats['stored']} stored, {stats['errors']} errors"
             + (" (DRY RUN)" if dry_run else ""))
    finally:
        conn.close()

    # A run where every symbol errored wrote nothing and must not report success -- the
    # skip/zero-progress-as-success class (recurring-bugs.md). Gated on "did anything land",
    # not on an error RATE: a symbol genuinely having no block deals is normal and common.
    if stats["errors"] and stats["deals"] == 0:
        print(f"[MCBlockDeal] ZERO deals parsed across {stats['symbols']} symbols with "
              f"{stats['errors']} errors -- nothing landed.", file=sys.stderr)
        sys.exit(1)
    return stats


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="MoneyControl block-deal history -> block_deals")
    ap.add_argument("--symbol", help="single NSE symbol (used by the live_datasource test)")
    ap.add_argument("--limit", type=int, default=200, help="universe size by market cap")
    ap.add_argument("--dry-run", action="store_true", help="fetch and parse, do not write")
    args = ap.parse_args()
    print(json.dumps(run(symbol_filter=args.symbol, limit=args.limit, dry_run=args.dry_run)))
