#!/usr/bin/env python3
"""
FinStack MCP Quarterly Cash-Flow Fetcher
=========================================
First real QUARTERLY cash-flow history on this platform (P4 #19's quarterly half): populates
`finstack_cashflow_history` (operating/investing/financing CF, capex, FCF per quarter) by
calling the FinStack MCP server's `cash_flow(symbol, quarterly=true)` tool through
mcp_client.McpStdioClient — the same `python -m finstack.server` command the interactive
Claude config runs. Protocol-level integration: survives finstack upgrades, no finstack
import and no plan-gated REST involved.

Source honesty: finstack's cash_flow tool is a thin wrapper over yfinance's
ticker.quarterly_cashflow (verified in the installed finstack.data.fundamentals source).
Yahoo carries quarterly cash-flow for only a SUBSET of NSE names — live-probed 2026-09-01:
INFY returns 4 quarters (reported in USD — stored per-row in `currency`), RELIANCE returns
finstack's {"error": true} envelope. Missing names are SKIPPED, never fabricated.

⚠ An absence in this table does NOT automatically mean "vendor has no quarterly cash flow" —
Yahoo throttles hard, and a throttled call returns the SAME {"error": true} envelope shape as
genuine no-coverage. Until 2026-09-10 the two were indistinguishable and a fully-throttled run
exited 0 reporting the whole universe as "no vendor coverage" (AF-20260910-06). Rate-limiting is
now classified separately, backed off, aborted once sustained, and exits non-zero. Read the run's
own summary line before drawing any conclusion about vendor coverage from row counts: as of
2026-09-10 this table holds only 59 rows / 15 symbols, and how much of that is true Yahoo
coverage vs. accumulated throttling has NOT been established.

Cadence: weekly (same rationale as the marketsmojo trio — vendors restate quarterly figures
around results days; a weekly pass converges, and 45-day warn windows fit any future DQ check).

Runs under the repo venv but SPAWNS the server via PATH's `python` (where finstack is
installed); override with --server-cmd or MCP_SERVER_CMD if the layout differs.

Run:
  python finstack_cashflow_fetcher.py                # stocklist.json universe, 6 workers
  python finstack_cashflow_fetcher.py --symbol INFY
  python finstack_cashflow_fetcher.py --limit 50 --workers 3

Resilience (2026-09-02 hardening after a live full-universe hang): every MCP call is bounded
by McpStdioClient's call timeout; a channel that times out or errors is closed and replaced
(recycle cap prevents spawn storms) and the symbol is honest-skipped; run() always closes
every MCP server process in a finally — zero leaks even when the pool dies mid-flight.
"""

import argparse
import json
import os
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from db_compat import connect

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcp_client import McpError, McpStdioClient  # noqa: E402

DEFAULT_SERVER_CMD = ["python", "-m", "finstack.server"]
STOCKLIST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "..", "..", "scripts", "stocklist.json")

# The five statement lines worth persisting (finstack lowercases + underscores the
# yfinance row labels). Everything else in the payload is derivable or noise for us.
_CF_KEYS = {
    "operating_cash_flow": "ocf",
    "investing_cash_flow": "cfi",
    "financing_cash_flow": "cff",
    "capital_expenditure": "capex",
    "free_cash_flow": "fcf",
}

# AF-20260910-06. finstack wraps yfinance, and Yahoo answers a throttled caller with a
# business-error envelope carrying "Too Many Requests. Rate limited." -- structurally identical
# to the envelope meaning "Yahoo has no quarterly cash flow for this name". Until 2026-09-10 both
# collapsed to [] and were counted as "no vendor coverage", so a fully-throttled run over ~2,000
# symbols reported "0 wrote, 2000 had no vendor coverage" and exited 0. That is the same class as
# insider_transactions_fetcher's `None`-on-failure vs `[]`-on-genuinely-empty fix (see
# recurring-bugs.md): a throttled run must never be indistinguishable from an empty universe.
_RATE_LIMIT_MARKERS = ("too many requests", "rate limit", "429")

# Past this many throttled symbols the vendor is refusing the whole run: continuing burns the
# remaining universe for nothing AND keeps the throttle warm. Stop and report instead.
RATE_LIMIT_ABORT_THRESHOLD = 25
RATE_LIMIT_BACKOFF_SEC = 2.0


class RateLimited(Exception):
    """The vendor throttled us. NOT the same as 'the vendor has no data for this symbol'."""


def is_rate_limited_envelope(envelope: object) -> bool:
    """True only for a business-error envelope whose text says we were throttled. Pure."""
    if not isinstance(envelope, dict) or not envelope.get("error"):
        return False
    blob = " ".join(
        str(envelope.get(k, "")) for k in ("message", "error", "detail", "reason")
    ).lower()
    return any(m in blob for m in _RATE_LIMIT_MARKERS)


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS finstack_cashflow_history (
            symbol       TEXT NOT NULL,
            period_end   TEXT NOT NULL,
            ocf          REAL,
            cfi          REAL,
            cff          REAL,
            capex        REAL,
            fcf          REAL,
            currency     TEXT,
            fetched_at   TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, period_end)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_fch_sym
        ON finstack_cashflow_history(symbol, period_end DESC)
    """)
    con.commit()


def parse_quarterly_cashflow(envelope: dict | None) -> list[dict]:
    """Flatten a finstack cash_flow tool result into row dicts for upsert. Pure.

    Returns [] for the business-error envelope ({"error": true, ...}), malformed payloads,
    and payloads with no usable period — callers skip such symbols silently. Each kept row
    has at least one non-None cash-flow figure; numbers are rounded to 2dp."""
    if not isinstance(envelope, dict) or envelope.get("error"):
        return []
    currency = envelope.get("currency")
    rows: list[dict] = []
    for period in envelope.get("data") or []:
        if not isinstance(period, dict) or not period.get("period"):
            continue
        values = {}
        for src, dst in _CF_KEYS.items():
            val = period.get(src)
            values[dst] = round(float(val), 2) if val is not None else None
        if all(v is None for v in values.values()):
            continue
        rows.append({"period_end": str(period["period"])[:10], "currency": currency, **values})
    return rows


def load_universe(symbol_filter: list[str] | None, limit: int | None) -> list[str]:
    """Symbols from scripts/stocklist.json (the same universe financial_ratios_fetcher
    walks), optionally filtered/limited."""
    with open(STOCKLIST_PATH, encoding="utf-8-sig") as fh:
        entries = json.load(fh)
    symbols = sorted({(e.get("symbol") or "").strip().upper() for e in entries} - {""})
    if symbol_filter:
        wanted = {s.strip().upper() for s in symbol_filter}
        symbols = [s for s in symbols if s in wanted]
    if limit:
        symbols = symbols[:limit]
    return symbols


def upsert_cashflow(symbol: str, rows: list[dict], con) -> None:
    """Idempotent per (symbol, period_end): weekly runs refresh figures in place instead of
    accumulating rows. Only rows with at least one non-None figure reach here (parser)."""
    if not rows:
        return
    cur = con.cursor()
    cur.executemany("""
        INSERT INTO finstack_cashflow_history (symbol, period_end, ocf, cfi, cff, capex, fcf, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, period_end) DO UPDATE SET
            ocf = excluded.ocf,
            cfi = excluded.cfi,
            cff = excluded.cff,
            capex = excluded.capex,
            fcf = excluded.fcf,
            currency = excluded.currency,
            fetched_at = CURRENT_TIMESTAMP
    """, [(symbol, r["period_end"], r["ocf"], r["cfi"], r["cff"], r["capex"], r["fcf"], r["currency"])
          for r in rows])
    con.commit()


def fetch_symbol(mcp: McpStdioClient, symbol: str) -> list[dict]:
    """Call finstack cash_flow(quarterly=true) for one symbol and parse the envelope.
    Returns [] on business-error envelope, malformed payload, or empty vendor coverage —
    missing data is the expected common case, not an exception-worthy event. Raises
    McpError on transport/protocol trouble (timeout, wedged or dead channel); run()
    recycles the channel in that case and honest-skips the symbol."""
    text = mcp.call_tool("cash_flow", {"symbol": symbol, "quarterly": True})
    try:
        envelope = json.loads(text)
    except json.JSONDecodeError:
        return []
    # Classify BEFORE parsing: parse_quarterly_cashflow() flattens every error envelope to []
    # and cannot tell "throttled" from "no coverage" -- that conflation is the bug.
    if is_rate_limited_envelope(envelope):
        raise RateLimited(str(envelope.get("message") or envelope.get("error"))[:200])
    return parse_quarterly_cashflow(envelope)


def run(symbols: list[str] | None = None, limit: int | None = None,
        workers: int = 6, server_cmd: list[str] | None = None,
        stats: dict | None = None) -> int:
    """Returns the number of symbols written (unchanged contract).

    `stats`, when passed, is populated with the run's honest outcome breakdown
    (written / empty / rate_limited / aborted) so main() can exit non-zero on a throttled
    run instead of reporting a clean success over an empty result."""
    t0 = time.time()
    universe = load_universe(symbols, limit)
    if not universe:
        print("[FCH] nothing to fetch (empty universe).")
        return 0

    con = connect()
    ensure_schema(con)

    # one MCP server process per worker thread (stdio is single-channel per process)
    client_queue: "queue.Queue[McpStdioClient]" = queue.Queue()
    all_clients: list[McpStdioClient] = []
    for _ in range(max(1, workers)):
        c = McpStdioClient(server_cmd)
        all_clients.append(c)
        client_queue.put(c)

    done = 0
    written = 0
    empty = 0
    recycled = 0
    rate_limited = 0
    aborted = 0
    recycle_cap = 50  # beyond this, keep the channel: avoid a pathological spawn storm
    lock = threading.Lock()
    abort = threading.Event()

    def _task(sym: str) -> tuple[str, list[dict], str]:
        nonlocal recycled, rate_limited
        # Once the vendor is refusing the run, stop issuing calls. Remaining symbols are
        # reported as skipped-by-abort, never as "no vendor coverage".
        if abort.is_set():
            return sym, [], 'aborted'
        client = client_queue.get()
        try:
            rows = fetch_symbol(client, sym)
        except RateLimited as exc:
            client_queue.put(client)  # channel is healthy; the VENDOR said no
            with lock:
                rate_limited += 1
                n = rate_limited
            if n <= 3:
                print(f"[FCH] {sym}: vendor rate-limited ({exc}) — backing off",
                      file=sys.stderr)
            if n >= RATE_LIMIT_ABORT_THRESHOLD and not abort.is_set():
                abort.set()
                print(f"[FCH] ABORTING: {n} symbols rate-limited — the vendor is throttling "
                      f"this run; continuing would burn the rest of the universe for nothing "
                      f"and keep the throttle warm.", file=sys.stderr)
            time.sleep(RATE_LIMIT_BACKOFF_SEC)
            return sym, [], 'rate_limited'
        except McpError as exc:
            # Channel state is unknowable after a timeout/transport error: swap it for a
            # fresh server process and honest-skip this symbol (never fabricate).
            with lock:
                capped = recycled >= recycle_cap
                recycled += 1
                n = recycled
            if not capped:
                try:
                    client.close()
                except Exception:
                    pass
                fresh = McpStdioClient(server_cmd)
                all_clients.append(fresh)
                client_queue.put(fresh)
            else:
                client_queue.put(client)
            if n <= 3:
                # stderr: runPython() inspects stderr to flag the run as degraded
                print(f"[FCH] {sym}: MCP channel error ({exc}); channel replaced, "
                      f"symbol skipped", file=sys.stderr)
            return sym, [], 'mcp_error'
        # healthy channel: hand it back for the next symbol (a `return` inside the try
        # suite would skip an else-clause here — do NOT put the handback in an else)
        client_queue.put(client)
        return sym, rows, ('ok' if rows else 'empty')

    try:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
            futures = {pool.submit(_task, s): s for s in universe}
            for fut in as_completed(futures):
                sym, rows, outcome = fut.result()
                with lock:
                    done += 1
                    if outcome == 'ok':
                        upsert_cashflow(sym, rows, con)
                        written += 1
                    elif outcome == 'empty':
                        # ONLY a clean vendor answer with no periods counts as "no coverage".
                        empty += 1
                    elif outcome == 'aborted':
                        aborted += 1
                    # 'rate_limited' / 'mcp_error' are already counted in their handlers
                    if done % 100 == 0:
                        print(f"[FCH] {done}/{len(universe)} symbols ({written} with data, "
                              f"{empty} no coverage, {rate_limited} rate-limited, "
                              f"{recycled} channel recycles)")
    finally:
        # zero-leak: whatever happens, no MCP server process outlives this run. Close by
        # registry, not by queue — clients in-flight when a task died never re-entered it.
        con.commit()
        for c in all_clients:
            try:
                c.close()
            except Exception:
                pass

    print(f"[FCH] done: {written}/{len(universe)} symbols wrote quarterly cash-flow, "
          f"{empty} had no vendor coverage, {rate_limited} rate-limited, {aborted} skipped "
          f"after abort, {recycled} channel recycles ({time.time() - t0:.1f}s).")
    if stats is not None:
        stats.update(universe=len(universe), written=written, empty=empty,
                     rate_limited=rate_limited, aborted=aborted, recycled=recycled)
    if rate_limited:
        # stderr, not stdout: runPython() only inspects stderr to flag a run as degraded
        # (see recurring-bugs.md's degraded-read-print-to-stdout entry).
        print(f"[FCH] DEGRADED: {rate_limited} symbol(s) were rate-limited and "
              f"{aborted} were skipped after abort — their absence from "
              f"finstack_cashflow_history means THROTTLED, not 'vendor has no data'.",
              file=sys.stderr)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description="FinStack MCP quarterly cash-flow fetcher")
    parser.add_argument("--symbols", help="comma-separated NSE symbols (default: stocklist.json)")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--server-cmd", default=None,
                        help="override MCP server command, e.g. 'python -m finstack.server'")
    args = parser.parse_args()

    sym_filter = [s.strip() for s in args.symbols.split(",")] if args.symbols else None
    cmd = args.server_cmd.split() if args.server_cmd else None
    stats: dict = {}
    run(symbols=sym_filter, limit=args.limit, workers=args.workers, server_cmd=cmd,
        stats=stats)
    # Exit non-zero when the vendor throttled us. Returning 0 here is what let a run that
    # wrote NOTHING because Yahoo refused every call be recorded as a clean success.
    return 1 if stats.get("rate_limited") else 0


if __name__ == "__main__":
    sys.exit(main())

