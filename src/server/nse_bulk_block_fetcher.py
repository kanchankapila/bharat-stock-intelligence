#!/usr/bin/env python3
"""NSE daily bulk-deal and block-deal archive files -> nse_bulk_block_deals (AF-20261008-38).

Source (probed 2026-10-10): https://nsearchives.nseindia.com/content/equities/{bulk,block}.csv,
200 text/csv through the preopen_fetcher NSE session (browser UA + homepage cookie).
  bulk.csv : Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,
             Trade Price / Wght. Avg. Price,Remarks       (155 rows for 09-OCT-2026)
  block.csv: the same minus Remarks; a no-deal day is one "NO RECORDS" row.
Both are a snapshot of the LAST trading day only: dated names (bulk_09102026.csv, block_09102026.csv,
bulk_deals_09102026.csv, BULK_09102026.csv) all 404, and /api/historical/{bulk,block}-deals are 503.
So there is no backfill; run once per trading day after NSE publishes (~19:00 IST, Last-Modified was
13:37 UTC). A re-run on a holiday re-reads the previous file and is a no-op upsert.

Why a new table and not bulk_block_deals: that table's key is (source, symbol, deal_date,
client_name, deal_type), and on 09-Oct 67 (client, symbol) pairs appear on BOTH sides -- the key
would keep one side and silently drop the other. This key adds side, quantity and price.

The file's Symbol is already the NSE symbol; a row is kept only if that symbol is in nse_stocks or
traded in nse_universe_history in the last 60 days (SME names are only in the latter). Anything else
is counted and reported, never mapped. 'NIL'/'-' quantities and prices stay NULL.

    python nse_bulk_block_fetcher.py
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
from collections import Counter

from db_compat import connect, executemany_batched
from nse_filings_common import (
    BudgetExhausted, NseBlocked, NseClient, NseFetchError, clean_text, parse_date, parse_num,
)

TABLE = "nse_bulk_block_deals"
URL = "https://nsearchives.nseindia.com/content/equities/{kind}.csv"
PREFIX = "[NSE-BULK-BLOCK]"
KEY = ("deal_type", "trade_date", "symbol", "client_name", "buy_sell", "quantity", "price")
COLUMNS = KEY + ("security_name", "value_cr", "remarks", "source")
HEADERS = {"date": "Date", "symbol": "Symbol", "client": "Client Name", "side": "Buy/Sell",
           "qty": "Quantity Traded", "price": "Trade Price / Wght. Avg. Price"}


def ensure_schema(conn) -> None:
    # UNIQUE NULLS NOT DISTINCT (PG15+): quantity/price may be NULL ('NIL'/'-'), which a PRIMARY KEY
    # forbids and a plain UNIQUE would treat as never-equal (so a re-run would duplicate the row).
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            deal_type      TEXT NOT NULL,
            trade_date     DATE NOT NULL,
            symbol         TEXT NOT NULL,
            client_name    TEXT NOT NULL,
            buy_sell       TEXT,
            quantity       DOUBLE PRECISION,
            price          DOUBLE PRECISION,
            security_name  TEXT,
            value_cr       DOUBLE PRECISION,
            remarks        TEXT,
            source         TEXT NOT NULL DEFAULT 'nse_archive',
            fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT nse_bulk_block_deals_key
                UNIQUE NULLS NOT DISTINCT (deal_type, trade_date, symbol, client_name, buy_sell, quantity, price)
        )""")
    conn.execute(f"CREATE INDEX IF NOT EXISTS idx_nbbd_sym_date ON {TABLE} (symbol, trade_date DESC)")
    conn.commit()


def load_known_symbols(conn) -> set[str]:
    rows = conn.execute("""
        SELECT symbol FROM nse_stocks
        UNION SELECT DISTINCT symbol FROM nse_universe_history WHERE date >= CURRENT_DATE - 60
    """).fetchall()
    return {r[0] for r in rows if r[0]}


def _side(v) -> str | None:
    s = (clean_text(v) or "").upper()
    return "BUY" if s in ("BUY", "B") else "SELL" if s in ("SELL", "S") else None


def parse_csv(text: str, deal_type: str, known: set[str]) -> tuple[list[dict], dict]:
    """One archive file -> (rows, stats). Raises NseFetchError on anything that is not the expected
    CSV (an HTML block page, a renamed column), so a format change can never read as a no-deal day."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    header = [h.strip() for h in (reader.fieldnames or [])]
    missing = [h for h in HEADERS.values() if h not in header]
    if missing:
        raise NseFetchError(f"{deal_type}.csv header {header[:8]} lacks {missing}")
    reader.fieldnames = header
    rows, stats, unmapped = {}, {"raw": 0, "unmapped": 0, "unkeyable": 0, "empty_file": False}, Counter()
    for raw in reader:
        if (raw.get("Date") or "").strip().upper() == "NO RECORDS":
            stats["empty_file"] = True
            continue
        stats["raw"] += 1
        symbol = (clean_text(raw.get(HEADERS["symbol"])) or "").upper()
        if symbol not in known:
            unmapped[symbol or "?"] += 1
            continue
        trade_date, client = parse_date(raw.get(HEADERS["date"])), clean_text(raw.get(HEADERS["client"]))
        if trade_date is None or client is None:
            stats["unkeyable"] += 1
            continue
        qty, price = parse_num(raw.get(HEADERS["qty"])), parse_num(raw.get(HEADERS["price"]))
        r = {
            "deal_type": deal_type, "trade_date": trade_date, "symbol": symbol, "client_name": client,
            "buy_sell": _side(raw.get(HEADERS["side"])), "quantity": qty, "price": price,
            "security_name": clean_text(raw.get("Security Name")),
            "value_cr": qty * price / 1e7 if qty is not None and price is not None else None,
            "remarks": clean_text(raw.get("Remarks")), "source": "nse_archive",
        }
        rows[row_key(r)] = r
    stats["unmapped"] = sum(unmapped.values())
    if unmapped:
        print(f"{PREFIX} {deal_type}: {stats['unmapped']} row(s) with a symbol outside nse_stocks/"
              f"nse_universe_history, skipped: {dict(unmapped.most_common(10))}", file=sys.stderr)
    return list(rows.values()), stats


def row_key(r: dict) -> tuple:
    return tuple(r[k] for k in KEY)


def upsert(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c not in KEY)
    executemany_batched(conn, f"""
        INSERT INTO {TABLE} ({", ".join(COLUMNS)}) VALUES ({", ".join("?" for _ in COLUMNS)})
        ON CONFLICT ON CONSTRAINT nse_bulk_block_deals_key DO UPDATE SET {upd}, fetched_at = now()""",
        [tuple(r[c] for c in COLUMNS) for r in rows])
    conn.commit()
    return len(rows)


def run(conn, client: NseClient, known: set[str]) -> dict:
    stats = {"stop": None}
    try:
        for kind in ("bulk", "block"):
            rows, s = parse_csv(client.get_text(URL.format(kind=kind)), kind, known)
            s["written"] = upsert(conn, rows)
            s["trade_dates"] = sorted({r["trade_date"].isoformat() for r in rows})
            stats[kind] = s
            print(f"{PREFIX} {kind}: {s}")
    except BudgetExhausted as exc:
        stats["stop"] = f"budget: {exc}"
    except (NseBlocked, NseFetchError) as exc:
        stats["stop"] = f"error: {exc}"
    for kind in ("bulk", "block"):
        stats.setdefault(kind, {"written": 0})
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--max-requests", type=int, default=12)
    ap.add_argument("--min-interval", type=float, default=1.5)
    args = ap.parse_args(argv)
    conn = connect()
    ensure_schema(conn)
    client = NseClient(args.max_requests, args.min_interval, log_prefix=PREFIX)
    stats = run(conn, client, load_known_symbols(conn))
    conn.close()
    print(f"{PREFIX} done: {stats} statuses={dict(client.status_counts)}")
    if stats["stop"]:
        print(f"{PREFIX} stopped: {stats['stop']}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
