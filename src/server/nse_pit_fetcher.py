#!/usr/bin/env python3
"""NSE insider-trading (SEBI PIT) disclosures, market-wide, dissemination-dated -> nse_pit_disclosures.

Why: insider_trades covers 232-445 symbols/yr and is dated by TRANSACTION date, which is not when
the market could know. This table keeps NSE's dissemination timestamp (`date`) plus the
intimation date, so a test of promoter open-market buys can be point-in-time (audit G #7).

Endpoint (probed 2026-10-09): /api/corporates-pit?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
-> {"acqNameList": [...], "data": [...]}; the window filters on dissemination date and is honoured
market-wide (the per-symbol `symbol=&from=&to=` form insider_transactions_fetcher used ignores its
dates -- a different query shape). No pagination: a busy 5-day window returned 229 rows in one body.
Does NOT write to insider_trades / insider_transactions.
KNOWN CUTOFF (probed 2026-10-09): the route serves nothing disseminated after 2026-05-02 (28-Apr..
02-May-2026 -> 38 rows; 01..05-Jul-2026 and 01..08-Oct-2026 -> empty), the same cutoff
insider_transactions shows. The backfill is valid to then; --daily writes nothing until a successor
route is found (needs a captured browser fetch from the user, per data-sources.md).

    python nse_pit_fetcher.py                       # resume backfill from MAX(dissemination_ts)
    python nse_pit_fetcher.py --since 2021-01-01 --until 2021-06-30 --max-requests 50
    python nse_pit_fetcher.py --daily
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta

from db_compat import connect, executemany_batched
from nse_filings_common import (
    NSE_API, BudgetExhausted, NseBlocked, NseClient, NseFetchError, SymbolResolver, clean_text,
    nse_date_param, parse_date, parse_num, parse_ts, resume_start, today_ist, windows,
)

TABLE = "nse_pit_disclosures"
DEFAULT_SINCE = date(2021, 1, 1)
URL = NSE_API + "/corporates-pit?index=equities&from_date={f}&to_date={t}"
PREFIX = "[NSE-PIT]"
KEY = ("symbol", "did", "dissemination_ts")

COLUMNS = ("symbol", "nse_symbol_raw", "company_name", "did", "pid", "acq_name", "person_category",
           "acq_mode", "transaction_type", "sec_type", "derivative_type", "sec_acq", "sec_val",
           "before_shares", "before_pct", "after_shares", "after_pct", "buy_qty", "buy_value",
           "sell_qty", "sell_value", "transaction_from", "transaction_to", "intimation_dt",
           "dissemination_ts", "exchange", "anex", "remarks", "xbrl_url")


def ensure_schema(conn) -> None:
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            symbol            TEXT NOT NULL,
            nse_symbol_raw    TEXT,
            company_name      TEXT,
            did               TEXT NOT NULL,
            pid               TEXT,
            acq_name          TEXT,
            person_category   TEXT,
            acq_mode          TEXT,
            transaction_type  TEXT,
            sec_type          TEXT,
            derivative_type   TEXT,
            sec_acq           DOUBLE PRECISION,
            sec_val           DOUBLE PRECISION,
            before_shares     DOUBLE PRECISION,
            before_pct        DOUBLE PRECISION,
            after_shares      DOUBLE PRECISION,
            after_pct         DOUBLE PRECISION,
            buy_qty           DOUBLE PRECISION,
            buy_value         DOUBLE PRECISION,
            sell_qty          DOUBLE PRECISION,
            sell_value        DOUBLE PRECISION,
            transaction_from  DATE,
            transaction_to    DATE,
            intimation_dt     DATE,
            dissemination_ts  TIMESTAMPTZ NOT NULL,
            exchange          TEXT,
            anex              TEXT,
            remarks           TEXT,
            xbrl_url          TEXT,
            fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (symbol, did, dissemination_ts)
        )""")
    conn.commit()


def parse_disclosure(raw: dict, resolver: SymbolResolver) -> dict | None:
    """One NSE PIT row -> row dict, or None when it cannot be keyed. NSE's `did` is the per-row
    detail id: the natural fields (person, dates, qty, side, ts) collided on 5 of 282 rows in the
    Feb-2022 sample, so they cannot be the key. 'Nil'/'-' stay NULL; a literal '0' stays 0."""
    symbol = resolver.resolve(raw.get("symbol"), raw.get("isin"))
    if symbol is None:
        return None
    row = {
        "symbol": symbol,
        "nse_symbol_raw": clean_text(raw.get("symbol")),
        "company_name": clean_text(raw.get("company")),
        "did": clean_text(raw.get("did")),
        "pid": clean_text(raw.get("pid")),
        "acq_name": clean_text(raw.get("acqName")),
        "person_category": clean_text(raw.get("personCategory")),
        "acq_mode": clean_text(raw.get("acqMode")),
        "transaction_type": clean_text(raw.get("tdpTransactionType")),
        "sec_type": clean_text(raw.get("secType")),
        "derivative_type": clean_text(raw.get("derivativeType")),
        "sec_acq": parse_num(raw.get("secAcq")),
        "sec_val": parse_num(raw.get("secVal")),
        "before_shares": parse_num(raw.get("befAcqSharesNo")),
        "before_pct": parse_num(raw.get("befAcqSharesPer")),
        "after_shares": parse_num(raw.get("afterAcqSharesNo")),
        "after_pct": parse_num(raw.get("afterAcqSharesPer")),
        "buy_qty": parse_num(raw.get("buyQuantity")),
        "buy_value": parse_num(raw.get("buyValue")),
        "sell_qty": parse_num(raw.get("sellquantity")),
        "sell_value": parse_num(raw.get("sellValue")),
        "transaction_from": parse_date(raw.get("acqfromDt")),
        "transaction_to": parse_date(raw.get("acqtoDt")),
        "intimation_dt": parse_date(raw.get("intimDt")),
        "dissemination_ts": parse_ts(raw.get("date")),
        "exchange": clean_text(raw.get("exchange")),
        "anex": clean_text(raw.get("anex")),
        "remarks": clean_text(raw.get("remarks")),
        "xbrl_url": clean_text(raw.get("xbrl")),
    }
    if row["did"] is None or row["dissemination_ts"] is None:
        return None
    return row


def parse_response(payload, resolver: SymbolResolver) -> tuple[list[dict], int]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise NseFetchError(f"unexpected PIT payload: {str(payload)[:200]}")
    rows, bad = {}, 0
    for raw in data:
        r = parse_disclosure(raw, resolver) if isinstance(raw, dict) else None
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


def crawl(conn, client: NseClient, start: date, end: date) -> dict:
    resolver = SymbolResolver.from_db(conn)
    stats = {"windows": 0, "fetched": 0, "written": 0, "unkeyable": 0, "last_window_end": None, "stop": None}
    try:
        for w_start, w_end in windows(start, end):
            payload = client.get_json(URL.format(f=nse_date_param(w_start), t=nse_date_param(w_end)))
            rows, bad = parse_response(payload, resolver)
            stats["fetched"] += len(payload["data"])
            stats["unkeyable"] += bad
            stats["written"] += upsert(conn, rows)
            stats["windows"] += 1
            stats["last_window_end"] = w_end
            print(f"{PREFIX} {w_start}..{w_end}: {len(rows)} rows (requests {client.requests_made}/{client.max_requests})")
    except BudgetExhausted as exc:
        stats["stop"] = f"budget: {exc}"
    except (NseBlocked, NseFetchError) as exc:
        stats["stop"] = f"error: {exc}"
    resolver.report(PREFIX)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--since", type=date.fromisoformat, help="default: resume from MAX(dissemination_ts), else 2021-01-01")
    ap.add_argument("--until", type=date.fromisoformat, help="default: today IST")
    ap.add_argument("--daily", action="store_true", help="incremental: the last 10 days only")
    ap.add_argument("--max-requests", type=int, default=450)
    ap.add_argument("--min-interval", type=float, default=1.5)
    args = ap.parse_args(argv)

    conn = connect()
    ensure_schema(conn)
    end = args.until or today_ist()
    start = end - timedelta(days=9) if args.daily else (
        args.since or resume_start(conn, TABLE, "dissemination_ts", DEFAULT_SINCE))
    print(f"{PREFIX} crawling {start}..{end} budget={args.max_requests}")
    client = NseClient(args.max_requests, args.min_interval, log_prefix=PREFIX)
    stats = crawl(conn, client, start, end)
    conn.close()
    print(f"{PREFIX} done: {stats} statuses={dict(client.status_counts)}")
    return 2 if stats["stop"] and stats["stop"].startswith("error") else 0


if __name__ == "__main__":
    sys.exit(main())
