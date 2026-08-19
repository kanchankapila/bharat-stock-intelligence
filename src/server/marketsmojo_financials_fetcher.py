#!/usr/bin/env python3
"""
MarketsMojo get-financials historical fetcher.

qtype=qoq, card=1, paginated: page 1 alone returns ~6 consecutive quarters, and paging further
back keeps returning real data -- confirmed live 2026-08-11 against sid=592009 (HDFCBANK):
Dec'17 through Jun'26, ~34 quarters (~8.5 years), unauthenticated, both consolidated and
standalone statements. (qtype=yoy was tried first and rejected: each page only returns one
same-quarter-last-year pair and skips ~7 quarters between pages -- a sparse sample, not a
dense series.) card values other than 1 return HTTP 500 for this endpoint; not pursued further.

This is the fundamentals-history depth .claude/rules/measurement.md flags as missing platform-
wide. ET's equivalent (ET_Stats Balance/CashFlow/Quarterly/Ratio, already wired via
financial_ratios_fetcher.py/working_capital_fetcher.py) tops out at 5-8 years/8 quarters; this
is an independent second source with different depth and line-item granularity.

symbol resolution and headers are shared with marketsmojo_technical_fetcher.py (same
stocklist.json-backed stockid map, same 403-without-headers endpoint family).
"""

import argparse
import json
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import connect  # noqa: E402
from marketsmojo_technical_fetcher import HEADERS, load_sid_map  # noqa: E402

BASE_URL = "https://frapi.marketsmojo.com/apiv1/financials/get-financials"
RATE_LIMIT_SEC = 0.5
MAX_PAGES = 8  # confirmed real data through page 5 for HDFCBANK; page 6 already empty

# AF-20260816-20: this is quarterly-cadence data (queues.ts's own comment: "the vendor only
# restates these on results/filing days") fetched by a WEEKLY job -- a symbol checked earlier
# this week doesn't need re-fetching before next week's run. See marketsmojo_financials_checked
# (migration 1787090000000) for why this can't be answered from marketsmojo_financials_history
# alone.
STALENESS_DAYS = 7


def _flatten_statement(stmt_key: str, rows: list, period_keys: list) -> list[tuple[str, str, str]]:
    """Recursively flattens a statement's rows (each row optionally nesting more rows under
    'items') into (period_label, line_item, raw_value) tuples."""
    out = []
    for row in rows:
        line_item = row.get(stmt_key)
        if not line_item:
            continue
        for pk in period_keys:
            if pk in row and row[pk] is not None:
                out.append((pk, line_item, row[pk]))
        nested = row.get("items")
        if nested:
            out.extend(_flatten_statement(stmt_key, nested, period_keys))
    return out


def _parse_numeric(raw: str):
    try:
        return float(str(raw).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def fetch_financials_history(
    sid: str, session: requests.Session, exchange: str = "0", qtype: str = "qoq"
) -> list[tuple[str, str, str, str]] | None:
    """Walks pages until a page returns no new statement rows. Returns a flat list of
    (statement, period_label, line_item, raw_value) tuples, or None if nothing came back."""
    out: list[tuple[str, str, str, str]] = []
    for page in range(1, MAX_PAGES + 1):
        try:
            r = session.post(
                BASE_URL,
                json={
                    "sid": sid, "exchange": exchange, "period": "q",
                    "card": 1, "page": page, "type": 0, "qtype": qtype,
                },
                timeout=20,
            )
            if r.status_code != 200:
                print(f"  [marketsmojo financials] sid={sid} page={page} HTTP {r.status_code}")
                break
            payload = r.json()
            if str(payload.get("code")) != "200":
                break
            snapshot = payload.get("data", {}).get("snapshot", {})
        except Exception as e:
            print(f"  [marketsmojo financials] sid={sid} page={page} error: {e}", file=sys.stderr)
            break
        finally:
            time.sleep(RATE_LIMIT_SEC)

        if not snapshot:
            break

        got_new = False
        for stmt_key, block in snapshot.items():
            block_data = block.get("data", {})
            period_dates = block_data.get("period_dates", [])
            period_keys = [pd["key"] for pd in period_dates if pd.get("key") != stmt_key]
            rows = block_data.get(stmt_key, [])
            if not rows or not period_keys:
                continue
            flattened = _flatten_statement(stmt_key, rows, period_keys)
            if flattened:
                got_new = True
                out.extend((stmt_key, pk, li, val) for pk, li, val in flattened)
        if not got_new:
            break

    return out or None


def load_recently_checked(conn, staleness_days: int = STALENESS_DAYS) -> set[str]:
    """Symbols checked within the staleness window -- see marketsmojo_financials_checked's own
    migration comment for why this can't be derived from marketsmojo_financials_history."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=staleness_days)).isoformat()
    rows = conn.execute(
        "SELECT symbol FROM marketsmojo_financials_checked WHERE checked_at >= ?", (cutoff,)
    ).fetchall()
    return {r[0] for r in rows}


def mark_checked(conn, symbol: str) -> None:
    conn.execute(
        """
        INSERT INTO marketsmojo_financials_checked (symbol, checked_at) VALUES (?, ?)
        ON CONFLICT(symbol) DO UPDATE SET checked_at = excluded.checked_at
        """,
        (symbol, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


def load_known_values(conn, symbol: str) -> dict[tuple[str, str, str], float | None]:
    """(statement, period_label, line_item) -> stored value, for one symbol.

    This table has no date column to bound a "since" query by (PK is symbol/statement/
    period_label/line_item, not date) -- old reported quarters essentially never change, so the
    write-amplification fix here is "skip the write if the value hasn't changed" rather than
    technical_fetcher.py's "skip dates already held". Scoped per-symbol (not the whole table) to
    keep this cheap. Same write-amplification class as recurring-bugs.md's marketsmojo entry.
    """
    rows = conn.execute(
        "SELECT statement, period_label, line_item, value FROM marketsmojo_financials_history "
        "WHERE symbol = ?", (symbol,)
    ).fetchall()
    return {(r[0], r[1], r[2]): r[3] for r in rows}


def write_financials_history(conn, symbol: str, rows: list, fetched_at: str,
                              known: dict[tuple[str, str, str], float | None] | None = None) -> int:
    """rows: [(statement, period_label, line_item, raw_value), ...]. Upserts one row per
    (symbol, statement, period_label, line_item). Returns rows actually written (changed/new)."""
    written = 0
    for statement, period_label, line_item, raw_value in rows:
        value = _parse_numeric(raw_value)
        key = (statement, period_label, line_item)
        # known.get(key) == value would also match a key NEVER SEEN before (dict.get's default
        # is None, same as an unparseable raw_value) -- silently skipping the first write for
        # any new cell whose value happens to be unparseable. `key in known` first makes "new"
        # and "already stored as NULL" distinguishable.
        if known is not None and key in known and known[key] == value:
            continue
        conn.execute(
            """
            INSERT INTO marketsmojo_financials_history
                (symbol, statement, period_label, line_item, value, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, statement, period_label, line_item) DO UPDATE SET
                value      = excluded.value,
                fetched_at = excluded.fetched_at
            """,
            (symbol, statement, period_label, line_item, value, fetched_at),
        )
        written += 1
    conn.commit()
    return written


def run(symbols: list[str] | None = None, full: bool = False) -> None:
    sid_map = load_sid_map()
    explicit_symbols = bool(symbols)
    symbols = [s.upper() for s in symbols] if symbols else sorted(sid_map.keys())
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    fetched_at = date.today().isoformat()

    # AF-20260816-20: skip a symbol checked within STALENESS_DAYS without paying its HTTP
    # round-trip -- only for the default full-universe sweep. --full (explicit re-upsert) and an
    # explicit --symbols list both mean "I want these checked now regardless of when we last
    # asked", so neither is filtered.
    recently_checked = (
        set() if full or explicit_symbols else load_recently_checked(conn)
    )
    skipped_fresh = 0

    total_rows = 0
    ok = 0
    for symbol in symbols:
        if symbol in recently_checked:
            skipped_fresh += 1
            continue
        sid = sid_map.get(symbol)
        if not sid:
            print(f"  [marketsmojo financials] {symbol}: no stockid mapping, skipped")
            continue
        rows = fetch_financials_history(sid, session)
        mark_checked(conn, symbol)
        if not rows:
            print(f"  [marketsmojo financials] {symbol}: empty response")
            continue
        known = None if full else load_known_values(conn, symbol)
        n = write_financials_history(conn, symbol, rows, fetched_at, known)
        total_rows += n
        ok += 1
        print(f"  [marketsmojo financials] {symbol}: {n} cells")

    conn.close()
    print(
        f"[marketsmojo financials] done -- {total_rows} cells, {ok}/{len(symbols)} symbols "
        f"succeeded, {skipped_fresh} skipped (checked within {STALENESS_DAYS}d)"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", help="restrict to these NSE symbols (default: full universe)")
    parser.add_argument("--full", action="store_true", help="force a complete re-upsert (backfill/vendor restatement)")
    args = parser.parse_args()
    run(args.symbols, full=args.full)
