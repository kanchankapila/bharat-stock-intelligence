#!/usr/bin/env python3
"""NSE F&O market positioning: participant-wise OI/volume and the F&O ban list (AF-20261119-19).

Sources (probed 2026-11-19 through the shared NSE session, browser UA + homepage cookie):
  * https://nsearchives.nseindia.com/content/nsccl/fao_participant_{oi,vol}_DDMMYYYY.csv
    Title line '"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Nov 19, 2026"'
    (2022 files print 'Jan 03,2022'), then a 15-column header and one row each for Client, DII, FII, Pro
    and TOTAL. Contracts, not shares. Dated files are served back to at least 2022-01-03, so this one
    backfills. Market-wide: one value per participant per day, no symbol and no cross-section. The TOTAL
    row is stored as published; it can differ from the participant sum by a contract (19-Nov-2026).
  * https://nsearchives.nseindia.com/content/fo/fo_secban.csv
    'Securities in Ban For Trade Date 20-NOV-2026:' then '1,KAYNES' lines: stocks whose open interest
    crossed 95% of the market-wide position limit, so no fresh F&O positions may be opened on that
    trade date. Only the NEXT trade date is served (dated names 404), so history exists only if this
    runs every session. Symbols are the exchange's own NSE symbols; a row is kept only if the symbol is
    in nse_stocks or traded in nse_universe_history in the last 60 days, anything else is reported.

Both files appear after the close (participant files ~18:00-19:30 IST); ml-daily-ops runs this after its
bhavcopy step. Every date comes from the file, never the clock: a participant file whose title date is
not the requested session raises, and the ban list is stored under its own 'For Trade Date'. Each run
replaces that trade date's ban rows, so a name that left the list is not left behind.

    python nse_fo_market_positioning_fetcher.py                  # last 10 days of participant files + ban list
    python nse_fo_market_positioning_fetcher.py --since 2022-01-03 --max-requests 2000   # backfill
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import re
import sys
from collections import Counter

from as_of import logical_trading_date
from db_compat import connect, executemany_batched
from nse_filings_common import BudgetExhausted, NseBlocked, NseClient, NseFetchError, clean_text, parse_num

PREFIX = "[NSE-FO-POSITIONING]"
PARTICIPANT_URL = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_{kind}_{ddmmyyyy}.csv"
BAN_URL = "https://nsearchives.nseindia.com/content/fo/fo_secban.csv"
PARTICIPANT_TABLE = "nse_participant_positions"
BAN_TABLE = "nse_fo_ban_list"
KINDS = ("oi", "vol")
PARTICIPANTS = ("CLIENT", "DII", "FII", "PRO", "TOTAL")

# File header -> column, in file order. Header cells carry stray spaces/tabs ('Future Stock Short       ').
PARTICIPANT_COLUMNS = (
    ("Future Index Long", "fut_idx_long"), ("Future Index Short", "fut_idx_short"),
    ("Future Stock Long", "fut_stk_long"), ("Future Stock Short", "fut_stk_short"),
    ("Option Index Call Long", "opt_idx_call_long"), ("Option Index Put Long", "opt_idx_put_long"),
    ("Option Index Call Short", "opt_idx_call_short"), ("Option Index Put Short", "opt_idx_put_short"),
    ("Option Stock Call Long", "opt_stk_call_long"), ("Option Stock Put Long", "opt_stk_put_long"),
    ("Option Stock Call Short", "opt_stk_call_short"), ("Option Stock Put Short", "opt_stk_put_short"),
    ("Total Long Contracts", "total_long"), ("Total Short Contracts", "total_short"),
)
VALUE_COLS = tuple(c for _, c in PARTICIPANT_COLUMNS)
_TITLE_DATE = re.compile(r"as on\s+([A-Za-z]{3})\s+(\d{1,2})\s*,\s*(\d{4})", re.I)
_BAN_DATE = re.compile(r"For Trade Date\s+(\d{2}-[A-Za-z]{3}-\d{4})", re.I)


def ensure_schema(conn) -> None:
    cols = ",\n            ".join(f"{c} DOUBLE PRECISION" for c in VALUE_COLS)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {PARTICIPANT_TABLE} (
            trade_date   DATE NOT NULL,
            kind         TEXT NOT NULL,
            client_type  TEXT NOT NULL,
            {cols},
            source       TEXT NOT NULL DEFAULT 'nse_archive',
            fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (trade_date, kind, client_type)
        )""")
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {BAN_TABLE} (
            trade_date  DATE NOT NULL,
            symbol      TEXT NOT NULL,
            source      TEXT NOT NULL DEFAULT 'nse_archive',
            fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (trade_date, symbol)
        )""")
    conn.commit()


def parse_participant(text: str, kind: str, expected: dt.date) -> list[dict]:
    """One participant file -> five rows (Client, DII, FII, Pro, TOTAL). Raises NseFetchError on anything
    else (an HTML page, a renamed column, a file for another date) so it can never store a wrong day."""
    lines = [ln for ln in text.lstrip("\ufeff").splitlines() if ln.strip()]
    if len(lines) < 3:
        raise NseFetchError(f"participant {kind}: {len(lines)} non-empty lines")
    m = _TITLE_DATE.search(lines[0].replace('"', ''))  # 14-Oct-2022 vol title: 'as on Oct 14,"2022"""""'
    if not m:
        raise NseFetchError(f"participant {kind}: no 'as on <date>' in title {lines[0][:120]!r}")
    file_date = dt.datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%b %d %Y").date()
    if file_date != expected:
        raise NseFetchError(f"participant {kind}: file is for {file_date}, requested {expected}")
    reader = csv.reader(io.StringIO("\n".join(lines[1:])))
    header = [" ".join(h.split()) for h in next(reader)]
    want = ["Client Type"] + [h for h, _ in PARTICIPANT_COLUMNS]
    if header[:len(want)] != want:
        raise NseFetchError(f"participant {kind}: header {header} != {want}")
    rows = []
    for raw in reader:
        if not raw or not raw[0].strip():
            continue
        client_type = raw[0].strip().upper()
        if client_type not in PARTICIPANTS:
            raise NseFetchError(f"participant {kind}: unknown client type {raw[0]!r}")
        values = {col: parse_num(raw[i + 1] if i + 1 < len(raw) else None) for i, col in enumerate(VALUE_COLS)}
        rows.append({"trade_date": expected, "kind": kind, "client_type": client_type, **values})
    got = {r["client_type"] for r in rows}
    if got != set(PARTICIPANTS):
        raise NseFetchError(f"participant {kind}: client types {sorted(got)} != {sorted(PARTICIPANTS)}")
    return rows


def parse_ban(text: str, known: set[str]) -> tuple[dt.date, list[str], list[str]]:
    """fo_secban.csv -> (trade_date, symbols kept, symbols outside the known universe)."""
    lines = [ln.strip() for ln in text.lstrip("\ufeff").splitlines() if ln.strip()]
    m = _BAN_DATE.search(lines[0]) if lines else None
    if not m:
        raise NseFetchError(f"ban list: no 'For Trade Date' in {lines[:1]!r}")
    trade_date = dt.datetime.strptime(m.group(1).title(), "%d-%b-%Y").date()
    kept, unknown = [], []
    for ln in lines[1:]:
        parts = [p.strip() for p in ln.split(",")]
        symbol = (clean_text(parts[-1]) or "").upper()
        if not symbol or symbol in ("NIL", "NONE"):
            continue
        (kept if symbol in known else unknown).append(symbol)
    return trade_date, sorted(set(kept)), sorted(set(unknown))


def upsert_participant(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    cols = ("trade_date", "kind", "client_type") + VALUE_COLS
    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in VALUE_COLS)
    executemany_batched(conn, f"""
        INSERT INTO {PARTICIPANT_TABLE} ({", ".join(cols)}) VALUES ({", ".join("?" for _ in cols)})
        ON CONFLICT (trade_date, kind, client_type) DO UPDATE SET {upd}, fetched_at = now()""",
        [tuple(r[c] for c in cols) for r in rows])
    conn.commit()
    return len(rows)


def replace_ban(conn, trade_date: dt.date, symbols: list[str]) -> int:
    conn.execute(f"DELETE FROM {BAN_TABLE} WHERE trade_date = ?", (trade_date.isoformat(),))
    if symbols:
        executemany_batched(conn, f"INSERT INTO {BAN_TABLE} (trade_date, symbol) VALUES (?, ?)",
                            [(trade_date.isoformat(), s) for s in symbols])
    conn.commit()
    return len(symbols)


def load_known_symbols(conn) -> set[str]:
    rows = conn.execute("""
        SELECT symbol FROM nse_stocks
        UNION SELECT DISTINCT symbol FROM nse_universe_history WHERE date >= CURRENT_DATE - 60
    """).fetchall()
    return {r[0] for r in rows if r[0]}


def sessions(conn, since: dt.date, until: dt.date) -> list[dt.date]:
    """Sessions from the exchange's own bhavcopy record; F&O trades on the same days."""
    rows = conn.execute("SELECT DISTINCT date FROM nse_universe_history WHERE date BETWEEN ? AND ? ORDER BY 1",
                        (since.isoformat(), until.isoformat())).fetchall()
    return [dt.date.fromisoformat(str(r[0])[:10]) for r in rows]


def present(conn, since: dt.date, until: dt.date) -> set[tuple[dt.date, str]]:
    rows = conn.execute(f"""SELECT trade_date, kind FROM {PARTICIPANT_TABLE}
                            WHERE trade_date BETWEEN ? AND ? GROUP BY trade_date, kind
                            HAVING COUNT(*) = {len(PARTICIPANTS)}""",
                        (since.isoformat(), until.isoformat())).fetchall()
    return {(dt.date.fromisoformat(str(d)[:10]), k) for d, k in rows}


def run(conn, client: NseClient, since: dt.date, until: dt.date, known: set[str], ban: bool = True) -> dict:
    stats = {"participant_written": 0, "participant_skipped": 0, "not_published": [], "ban": None, "stop": None}
    have = present(conn, since, until)
    try:
        for d in sessions(conn, since, until):
            for kind in KINDS:
                if (d, kind) in have:
                    stats["participant_skipped"] += 1
                    continue
                url = PARTICIPANT_URL.format(kind=kind, ddmmyyyy=d.strftime("%d%m%Y"))
                try:
                    text = client.get_text(url)
                except NseFetchError as exc:
                    if "HTTP 404" in str(exc):
                        stats["not_published"].append(f"{d}:{kind}")
                        continue
                    raise
                stats["participant_written"] += upsert_participant(conn, parse_participant(text, kind, d))
        if ban:
            trade_date, kept, unknown = parse_ban(client.get_text(BAN_URL), known)
            if unknown:
                print(f"{PREFIX} ban list: {len(unknown)} symbol(s) outside nse_stocks/nse_universe_history, "
                      f"not stored: {unknown}", file=sys.stderr)
            stats["ban"] = {"trade_date": trade_date.isoformat(), "written": replace_ban(conn, trade_date, kept),
                            "symbols": kept, "unknown": unknown}
    except BudgetExhausted as exc:
        stats["stop"] = f"budget: {exc}"
    except (NseBlocked, NseFetchError) as exc:
        stats["stop"] = f"error: {exc}"
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--since", help="first session (default: --days-back before the logical trading date)")
    ap.add_argument("--days-back", type=int, default=10)
    ap.add_argument("--no-ban", action="store_true", help="participant files only (for a backfill)")
    ap.add_argument("--max-requests", type=int, default=40)
    ap.add_argument("--min-interval", type=float, default=1.5)
    args = ap.parse_args(argv)
    until = dt.date.fromisoformat(logical_trading_date())
    since = dt.date.fromisoformat(args.since) if args.since else until - dt.timedelta(days=args.days_back)
    conn = connect()
    ensure_schema(conn)
    client = NseClient(args.max_requests, args.min_interval, log_prefix=PREFIX)
    stats = run(conn, client, since, until, load_known_symbols(conn), ban=not args.no_ban)
    conn.close()
    print(f"{PREFIX} done {since}..{until}: {stats} statuses={dict(Counter(client.status_counts))}")
    if stats["stop"]:
        print(f"{PREFIX} stopped: {stats['stop']}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
