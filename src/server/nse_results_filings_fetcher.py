#!/usr/bin/env python3
"""NSE financial-results filings with their broadcast timestamps -> nse_results_filings.

Why: fundamentals in the DB (dalalos_financial_trends_history) carry period_end only, so every
reader applies a fixed lag. This table records WHEN each result became public (broadCastDate /
exchdisstime), so a point-in-time join can replace that lag (audit G #2, 2026-10-08).

Endpoint (probed 2026-10-09): /api/corporates-financial-results?index=equities&from_date=DD-MM-YYYY
&to_date=DD-MM-YYYY&period=<Quarterly|Annual>. The window filters on broadcast date. Without
`period` it returns []; `Half-Yearly` returned [] for a Nov-2022 window (SME-only, not crawled by
default). One 5-day peak window (10-14 Feb 2022, Quarterly) returned 1,119 rows -- no cap seen.

    python nse_results_filings_fetcher.py                      # integrated route, resume from its MAX(broadcast_ts)
    python nse_results_filings_fetcher.py --daily              # integrated route, last 10 days (schedule this)
    python nse_results_filings_fetcher.py --source legacy --since 2021-01-01 --until 2025-02-28
Legacy route: corporates-financial-results serves nothing after ~2025-02-13; its successor is the
integrated-filing route below (rows marked period='Integrated').
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta

from db_compat import connect, executemany_batched
from nse_filings_common import (
    NSE_API, BudgetExhausted, NseBlocked, NseClient, NseFetchError, SymbolResolver, clean_text,
    nse_date_param, parse_date, parse_ts, resume_start, today_ist, windows,
)

TABLE = "nse_results_filings"
DEFAULT_SINCE = date(2021, 1, 1)
PERIODS = ("Quarterly", "Annual")
URL = NSE_API + "/corporates-financial-results?index=equities&from_date={f}&to_date={t}&period={p}"
PREFIX = "[NSE-RESULTS]"

COLUMNS = ("symbol", "nse_symbol_raw", "isin", "company_name", "period_start", "period_end", "period",
           "relating_to", "audited", "consolidated", "cumulative", "ind_as", "bank_flag", "re_ind",
           "filing_ts", "broadcast_ts", "exch_diss_ts", "seq_number", "xbrl_url")


def ensure_schema(conn) -> None:
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            symbol          TEXT NOT NULL,
            nse_symbol_raw  TEXT,
            isin            TEXT,
            company_name    TEXT,
            period_start    DATE,
            period_end      DATE NOT NULL,
            period          TEXT NOT NULL,
            relating_to     TEXT,
            audited         TEXT,
            consolidated    TEXT NOT NULL,
            cumulative      TEXT,
            ind_as          TEXT,
            bank_flag       TEXT,
            re_ind          TEXT,
            filing_ts       TIMESTAMPTZ,
            broadcast_ts    TIMESTAMPTZ NOT NULL,
            exch_diss_ts    TIMESTAMPTZ,
            seq_number      TEXT,
            xbrl_url        TEXT,
            fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (symbol, period_end, period, consolidated, broadcast_ts)
        )""")
    conn.commit()


def parse_filing(raw: dict, resolver: SymbolResolver) -> dict | None:
    """One NSE row -> a row dict, or None when it cannot be keyed (unmapped symbol, or a missing
    period_end / period / consolidated / broadcast timestamp). Never fills a missing value."""
    symbol = resolver.resolve(raw.get("symbol"), raw.get("isin"))
    if symbol is None:
        return None
    row = {
        "symbol": symbol,
        "nse_symbol_raw": clean_text(raw.get("symbol")),
        "isin": clean_text(raw.get("isin")),
        "company_name": clean_text(raw.get("companyName")),
        "period_start": parse_date(raw.get("fromDate")),
        "period_end": parse_date(raw.get("toDate")),
        "period": clean_text(raw.get("period")),
        "relating_to": clean_text(raw.get("relatingTo")),
        "audited": clean_text(raw.get("audited")),
        "consolidated": clean_text(raw.get("consolidated")),
        "cumulative": clean_text(raw.get("cumulative")),
        "ind_as": clean_text(raw.get("indAs")),
        "bank_flag": clean_text(raw.get("bank")),
        "re_ind": clean_text(raw.get("reInd")),
        "filing_ts": parse_ts(raw.get("filingDate")),
        "broadcast_ts": parse_ts(raw.get("broadCastDate")),
        "exch_diss_ts": parse_ts(raw.get("exchdisstime")),
        "seq_number": clean_text(raw.get("seqNumber")),
        "xbrl_url": clean_text(raw.get("xbrl")),
    }
    if None in (row["period_end"], row["period"], row["consolidated"], row["broadcast_ts"]):
        return None
    return row


def parse_response(payload, resolver: SymbolResolver) -> tuple[list[dict], int]:
    """-> (rows, n_unkeyable). Raises on a payload that is not a list (an error envelope must not
    read as 'no filings this window')."""
    if not isinstance(payload, list):
        raise NseFetchError(f"unexpected results payload type {type(payload).__name__}: {str(payload)[:200]}")
    rows, bad = {}, 0
    for raw in payload:
        r = parse_filing(raw, resolver) if isinstance(raw, dict) else None
        if r is None:
            bad += 1
            continue
        rows[tuple(r[k] for k in ("symbol", "period_end", "period", "consolidated", "broadcast_ts"))] = r
    return list(rows.values()), bad


def upsert(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    cols = ", ".join(COLUMNS)
    ph = ", ".join("?" for _ in COLUMNS)
    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLUMNS
                    if c not in ("symbol", "period_end", "period", "consolidated", "broadcast_ts"))
    executemany_batched(conn, f"""
        INSERT INTO {TABLE} ({cols}) VALUES ({ph})
        ON CONFLICT (symbol, period_end, period, consolidated, broadcast_ts)
        DO UPDATE SET {upd}, fetched_at = now()""", [tuple(r[c] for c in COLUMNS) for r in rows])
    conn.commit()
    return len(rows)


def crawl(conn, client: NseClient, start: date, end: date, periods=PERIODS) -> dict:
    resolver = SymbolResolver.from_db(conn)
    stats = {"windows": 0, "fetched": 0, "written": 0, "unkeyable": 0, "last_window_end": None, "stop": None}
    try:
        for w_start, w_end in windows(start, end):
            for p in periods:
                payload = client.get_json(URL.format(f=nse_date_param(w_start), t=nse_date_param(w_end), p=p))
                rows, bad = parse_response(payload, resolver)
                stats["fetched"] += len(payload)
                stats["unkeyable"] += bad
                stats["written"] += upsert(conn, rows)
            stats["windows"] += 1
            stats["last_window_end"] = w_end
            print(f"{PREFIX} {w_start}..{w_end}: total written {stats['written']} "
                  f"(requests {client.requests_made}/{client.max_requests})")
    except BudgetExhausted as exc:
        stats["stop"] = f"budget: {exc}"
    except (NseBlocked, NseFetchError) as exc:
        stats["stop"] = f"error: {exc}"
    resolver.report(PREFIX)
    return stats


# ─── successor endpoint: integrated filing (financials), 2025-04 onward ──────
# corporates-financial-results stops serving data after ~2025-02-13. NSE's SEBI "integrated
# filing" route carries results from 2025-04-08 (earliest row seen; 14-Feb..15-Apr-2025 -> 13 rows,
# all from 08-Apr onward; 10..14-Feb-2025 -> totalCount 0, so the two routes do not overlap).
# Response: {"data": [...], "size", "page" (0-based echo), "totalCount"}; request `page` is
# 1-based and `size` is honoured up to at least 2000 (a 5-day peak window is ~1,450 rows).
# Rows land in the SAME table with period = 'Integrated' (the table has no source column), so
# they never collide with or overwrite a legacy 'Quarterly'/'Annual' row. Field mapping:
# qe_Date -> period_end, type_Sub ('Original'/'Revision') -> relating_to, creation_Date ->
# filing_ts, seq_Id -> seq_number. consolidated/audited are kept as given ('Standalone' here vs
# the legacy 'Non-Consolidated'). Revisions carry broadcast_Date = null; their own revised_Date is
# the time the revision was disseminated, so it is used as broadcast_ts for Revision rows only.
# Not stored (no column): revision_Remark, ixbrl, pdf_attach.
INTEGRATED_PERIOD = "Integrated"
INTEGRATED_SINCE = date(2025, 4, 1)
URL_INTEGRATED = (NSE_API + "/integrated-filing-results?index=equities&from_date={f}&to_date={t}"
                  "&type=Integrated%20Filing-%20Financials&page={page}&size={size}")
MAX_PAGES = 50


def parse_integrated(raw: dict, resolver: SymbolResolver) -> dict | None:
    symbol = resolver.resolve(raw.get("symbol"), None)
    if symbol is None:
        return None
    sub = clean_text(raw.get("type_Sub"))
    ts = parse_ts(raw.get("broadcast_Date"))
    if ts is None and sub == "Revision":
        ts = parse_ts(raw.get("revised_Date"))
    row = dict.fromkeys(COLUMNS)
    row.update({
        "symbol": symbol,
        "nse_symbol_raw": clean_text(raw.get("symbol")),
        "company_name": clean_text(raw.get("cmName")) or clean_text(raw.get("smName")),
        "period_end": parse_date(raw.get("qe_Date")),
        "period": INTEGRATED_PERIOD,
        "relating_to": sub,
        "audited": clean_text(raw.get("audited")),
        "consolidated": clean_text(raw.get("consolidated")),
        "filing_ts": parse_ts(raw.get("creation_Date")),
        "broadcast_ts": ts,
        "seq_number": clean_text(raw.get("seq_Id")),
        "xbrl_url": clean_text(raw.get("xbrl")),
    })
    if None in (row["period_end"], row["consolidated"], row["broadcast_ts"]):
        return None
    return row


def parse_integrated_response(payload, resolver: SymbolResolver) -> tuple[list[dict], int]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise NseFetchError(f"unexpected integrated-filing payload: {str(payload)[:200]}")
    rows, bad = {}, 0
    for raw in data:
        r = parse_integrated(raw, resolver) if isinstance(raw, dict) else None
        if r is None:
            bad += 1
            continue
        rows[tuple(r[k] for k in ("symbol", "period_end", "period", "consolidated", "broadcast_ts"))] = r
    return list(rows.values()), bad


def crawl_integrated(conn, client: NseClient, start: date, end: date, page_size: int = 2000) -> dict:
    resolver = SymbolResolver.from_db(conn)
    stats = {"windows": 0, "fetched": 0, "written": 0, "unkeyable": 0, "last_window_end": None, "stop": None}
    try:
        for w_start, w_end in windows(start, end):
            seen, page = 0, 1
            while True:
                payload = client.get_json(URL_INTEGRATED.format(
                    f=nse_date_param(w_start), t=nse_date_param(w_end), page=page, size=page_size))
                rows, bad = parse_integrated_response(payload, resolver)
                n = len(payload["data"])
                total = payload.get("totalCount") or 0
                seen += n
                stats["fetched"] += n
                stats["unkeyable"] += bad
                stats["written"] += upsert(conn, rows)
                if seen >= total:
                    break
                if n == 0 or page >= MAX_PAGES:
                    raise NseFetchError(f"pagination stalled at page {page}: {seen}/{total} rows for {w_start}..{w_end}")
                page += 1
            stats["windows"] += 1
            stats["last_window_end"] = w_end
            print(f"{PREFIX} integrated {w_start}..{w_end}: {seen} rows, total written {stats['written']} "
                  f"(requests {client.requests_made}/{client.max_requests})")
    except BudgetExhausted as exc:
        stats["stop"] = f"budget: {exc}"
    except (NseBlocked, NseFetchError) as exc:
        stats["stop"] = f"error: {exc}"
    resolver.report(PREFIX)
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--since", type=date.fromisoformat, help="window start (default: resume from MAX(broadcast_ts), else 2021-01-01)")
    ap.add_argument("--until", type=date.fromisoformat, help="window end (default: today IST)")
    ap.add_argument("--daily", action="store_true", help="incremental: the last 10 days only")
    ap.add_argument("--max-requests", type=int, default=900)
    ap.add_argument("--min-interval", type=float, default=1.5, help="seconds between requests (floor 1.0)")
    ap.add_argument("--periods", default=",".join(PERIODS), help="legacy source only")
    ap.add_argument("--source", choices=("integrated", "legacy"), default="integrated",
                    help="integrated = integrated-filing-results (2025-04 onward, the live route); "
                         "legacy = corporates-financial-results (data to ~2025-02-13)")
    args = ap.parse_args(argv)

    conn = connect()
    ensure_schema(conn)
    end = args.until or today_ist()
    integrated = args.source == "integrated"
    if args.daily:
        start = end - timedelta(days=9)
    elif integrated:
        start = args.since or resume_start(conn, TABLE, "broadcast_ts", INTEGRATED_SINCE,
                                           where=f"period = '{INTEGRATED_PERIOD}'")
    else:
        start = args.since or resume_start(conn, TABLE, "broadcast_ts", DEFAULT_SINCE,
                                           where=f"period <> '{INTEGRATED_PERIOD}'")
    client = NseClient(args.max_requests, args.min_interval, log_prefix=PREFIX)
    if integrated:
        print(f"{PREFIX} integrated crawl {start}..{end} budget={args.max_requests}")
        stats = crawl_integrated(conn, client, start, end)
    else:
        periods = tuple(p.strip() for p in args.periods.split(",") if p.strip())
        print(f"{PREFIX} legacy crawl {start}..{end} periods={periods} budget={args.max_requests}")
        stats = crawl(conn, client, start, end, periods)
    conn.close()
    print(f"{PREFIX} done: {stats} statuses={dict(client.status_counts)}")
    if stats["stop"] and stats["stop"].startswith("error"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
