#!/usr/bin/env python3
"""NSE shareholding-pattern master (promoter / public %, ~20 quarters per symbol) -> nse_shareholding_history.

Why: marketsmojo_shareholding_history holds ~5 quarters per symbol, too short to backtest. NSE's
master returns ~20 quarters (2021-09 onward) with submission and broadcast dates (audit G #6).

Endpoint (probed 2026-10-09): /api/corporate-share-holdings-master?index=equities&symbol=<SYM>
(symbol URL-encoded: M&M -> M%26M). One call per symbol, list of quarters.
Point-in-time caveats measured on TCS and M&M:
  * The master serves only the LATEST version of a quarter. M&M 31-MAR-2026 was submitted
    16-APR-2026 and revised 21-APR-2026; broadcastDate is the revision's. The original values are
    not here (only in the XBRL), so broadcast_ts is when THESE values became public.
  * Sep-2021 quarters carry a Jan-2022 broadcastDate though submitted in Oct-2021 (re-stamped by
    NSE). Using broadcast_ts is late, never early -- no look-ahead, just a conservative lag.
  * No pledge field in the master; pledge lives only in the per-filing XBRL (not fetched here).

    python nse_shareholding_master_fetcher.py --limit 50 --max-requests 60
    python nse_shareholding_master_fetcher.py                  # whole F&O + ADT>=Rs1cr universe, resumable
    python nse_shareholding_master_fetcher.py --symbol TCS --refresh
"""
from __future__ import annotations

import argparse
import sys
from urllib.parse import quote

from db_compat import connect, executemany_batched
from nse_filings_common import (
    NSE_API, BudgetExhausted, NseBlocked, NseClient, NseFetchError, clean_text, parse_date,
    parse_num, parse_ts,
)

TABLE = "nse_shareholding_history"
URL = NSE_API + "/corporate-share-holdings-master?index=equities&symbol={s}"
PREFIX = "[NSE-SHP]"
MIN_ADT_RUPEES = 1e7  # Rs 1 crore average daily traded value
KEY = ("symbol", "quarter_end", "broadcast_ts")
COLUMNS = ("symbol", "isin", "company_name", "quarter_end", "promoter_pct", "public_pct",
           "employee_trusts_pct", "submission_date", "broadcast_ts", "revised", "revision_date",
           "record_id", "xbrl_url")


def ensure_schema(conn) -> None:
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            symbol               TEXT NOT NULL,
            isin                 TEXT,
            company_name         TEXT,
            quarter_end          DATE NOT NULL,
            promoter_pct         DOUBLE PRECISION,
            public_pct           DOUBLE PRECISION,
            employee_trusts_pct  DOUBLE PRECISION,
            submission_date      DATE,
            broadcast_ts         TIMESTAMPTZ NOT NULL,
            revised              TEXT,
            revision_date        DATE,
            record_id            TEXT,
            xbrl_url             TEXT,
            fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (symbol, quarter_end, broadcast_ts)
        )""")
    conn.commit()


def load_universe(conn) -> list[str]:
    """F&O names first, then every other symbol whose average daily traded value over the last ~20
    sessions (30 calendar days back from the newest stock_ohlcv bar, not from the wall clock) is
    >= Rs 1 crore, most liquid first."""
    rows = conn.execute(f"""
        SELECT s.symbol
        FROM nse_stocks s
        LEFT JOIN (
            SELECT symbol, AVG(close * volume) AS adt
            FROM stock_ohlcv
            WHERE date >= (SELECT MAX(date) FROM stock_ohlcv) - 30 AND COALESCE(is_suspect, 0) = 0
            GROUP BY symbol
        ) a ON a.symbol = s.symbol
        WHERE s.fno_eligible = 1 OR a.adt >= {MIN_ADT_RUPEES}
        ORDER BY COALESCE(s.fno_eligible, 0) DESC, a.adt DESC NULLS LAST, s.symbol""").fetchall()
    return [r[0] for r in rows]


def parse_quarter(raw: dict, symbol: str) -> dict | None:
    row = {
        "symbol": symbol,
        "isin": clean_text(raw.get("isin")),
        "company_name": clean_text(raw.get("name")),
        "quarter_end": parse_date(raw.get("date")),
        "promoter_pct": parse_num(raw.get("pr_and_prgrp")),
        "public_pct": parse_num(raw.get("public_val")),
        "employee_trusts_pct": parse_num(raw.get("employeeTrusts")),
        "submission_date": parse_date(raw.get("submissionDate")),
        "broadcast_ts": parse_ts(raw.get("broadcastDate")),
        "revised": clean_text(raw.get("revisedData")),
        "revision_date": parse_date(raw.get("revisionDate")),
        "record_id": clean_text(raw.get("recordId")),
        "xbrl_url": clean_text(raw.get("xbrl")),
    }
    if row["quarter_end"] is None or row["broadcast_ts"] is None:
        return None
    return row


def parse_response(payload, symbol: str) -> tuple[list[dict], int]:
    """-> (rows, n_rejected). A row whose own `symbol` is a different company is rejected, never
    stored under the requested name."""
    if not isinstance(payload, list):
        raise NseFetchError(f"unexpected shareholding payload for {symbol}: {str(payload)[:200]}")
    rows, bad = {}, 0
    for raw in payload:
        if not isinstance(raw, dict) or (clean_text(raw.get("symbol")) or "").upper() != symbol.upper():
            bad += 1
            continue
        r = parse_quarter(raw, symbol)
        if r is None:
            bad += 1
            continue
        rows[tuple(r[k] for k in KEY)] = r
    return list(rows.values()), bad


def upsert(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS if c not in KEY)
    executemany_batched(conn, f"""
        INSERT INTO {TABLE} ({", ".join(COLUMNS)}) VALUES ({", ".join("?" for _ in COLUMNS)})
        ON CONFLICT ({", ".join(KEY)}) DO UPDATE SET {upd}, fetched_at = now()""",
        [tuple(r[c] for c in COLUMNS) for r in rows])
    conn.commit()
    return len(rows)


def crawl(conn, client: NseClient, symbols: list[str]) -> dict:
    stats = {"symbols_done": 0, "written": 0, "rejected": 0, "empty": [], "stop": None}
    try:
        for sym in symbols:
            payload = client.get_json(URL.format(s=quote(sym, safe="")))
            rows, bad = parse_response(payload, sym)
            stats["rejected"] += bad
            stats["written"] += upsert(conn, rows)
            stats["symbols_done"] += 1
            if not rows:
                stats["empty"].append(sym)
            if stats["symbols_done"] % 25 == 0:
                print(f"{PREFIX} {stats['symbols_done']}/{len(symbols)} symbols, {stats['written']} rows "
                      f"(requests {client.requests_made}/{client.max_requests})")
    except BudgetExhausted as exc:
        stats["stop"] = f"budget: {exc}"
    except (NseBlocked, NseFetchError) as exc:
        stats["stop"] = f"error: {exc}"
    if stats["empty"]:
        # ponytail: an empty symbol writes nothing, so a resume re-asks it; fine for a one-shot
        # backfill of liquid names, add a negative cache if it ever runs on a schedule.
        print(f"{PREFIX} {len(stats['empty'])} symbols returned no usable quarters: {stats['empty'][:30]}",
              file=sys.stderr)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--symbol", help="one or more comma-separated NSE symbols instead of the universe")
    ap.add_argument("--limit", type=int, help="first N symbols of the (remaining) universe")
    ap.add_argument("--refresh", action="store_true", help="re-fetch symbols already in the table")
    ap.add_argument("--max-requests", type=int, default=800)
    ap.add_argument("--min-interval", type=float, default=1.5)
    args = ap.parse_args(argv)

    conn = connect()
    ensure_schema(conn)
    symbols = [s.strip().upper() for s in args.symbol.split(",")] if args.symbol else load_universe(conn)
    if not args.refresh:
        have = {r[0] for r in conn.execute(f"SELECT DISTINCT symbol FROM {TABLE}").fetchall()}
        symbols = [s for s in symbols if s not in have]
    if args.limit:
        symbols = symbols[:args.limit]
    print(f"{PREFIX} {len(symbols)} symbols to fetch, budget={args.max_requests}")
    client = NseClient(args.max_requests, args.min_interval, log_prefix=PREFIX)
    stats = crawl(conn, client, symbols)
    conn.close()
    stats["empty"] = len(stats["empty"])
    print(f"{PREFIX} done: {stats} statuses={dict(client.status_counts)}")
    return 2 if stats["stop"] and stats["stop"].startswith("error") else 0


if __name__ == "__main__":
    sys.exit(main())
