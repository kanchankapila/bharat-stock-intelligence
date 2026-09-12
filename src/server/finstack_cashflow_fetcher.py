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
Yahoo identifies the NSE listing as `<symbol>.NS`, which this fetcher derives via
yahoo_ticker() — see that function for why the bare symbol is not merely a miss but a
wrong-company hit. Yahoo carries quarterly cash-flow for only a SUBSET of NSE names, and
missing names are SKIPPED, never fabricated.

⚠ Every row written before 2026-09-12 was fetched with the BARE symbol and is therefore
untrustworthy: 13 of the 17 symbols then in the table held a US-listed company's statements
(AF-20260912-01). Those rows were purged, not repaired — a wrong company's numbers cannot be
corrected into the right one's.

⚠ An absence in this table does NOT automatically mean "vendor has no quarterly cash flow" —
Yahoo throttles hard, and a throttled call returns the SAME {"error": true} envelope shape as
genuine no-coverage. Until 2026-09-10 the two were indistinguishable and a fully-throttled run
exited 0 reporting the whole universe as "no vendor coverage" (AF-20260910-06). Rate-limiting is
now classified separately, backed off, aborted once sustained, and exits non-zero. Read the run's
own summary line before drawing any conclusion about vendor coverage from row counts: as of
2026-09-10 this table holds only 59 rows / 15 symbols, and how much of that is true Yahoo
coverage vs. accumulated throttling has NOT been established.

Incremental mode (AF-20260912-14, after the rate-limit abort failed the ml-weekly-retrain verdict
three weeks running — 09-10, 09-11, 09-12): a full-universe crawl every week is exactly what keeps
the throttle warm. Same fix its siblings already shipped:
  - `finstack_cashflow_checked` marker + STALENESS_DAYS skip (marketsmojo_financials_checked
    pattern — the marker, NOT the history table, is the freshness source, because the ~majority
    of names are a clean "vendor has no coverage" and would otherwise be re-crawled forever);
  - a bounded, date-rotated batch (MAX_FETCH_PER_RUN) so a converging backfill makes progress
    every run without ever presenting Yahoo a 2,000-symbol wall;
  - a process-wide ThrottleGovernor: the first throttle cools ALL workers for 30s (doubling to a
    120s cap, 15-min cumulative budget), replacing the old per-thread 2s sleep that left 5
    threads hammering while one slept. Abort (25 throttles / budget exhausted) stays as the
    hard stop — but now it is reached by pacing, not by burst.
  - ET fallback: the batch's symbols are ALSO filled into `et_cashflow_history` (annual
    CFO/CFI/CFF) via financial_ratios_fetcher's existing parse/upsert against ET_Stats
    events=CashFlow — live-probed 2026-09-12 (RELIANCE/INFY/TCS all answer cleanly, and ET does
    not throttle this host the way Yahoo does). Separate table, never mixed with the quarterly
    series. The step now exits 0 when EITHER source made progress (the DEGRADED stderr note
    still fires, so the digest still sees a throttled Yahoo) and exits 1 only when nothing
    anywhere was written and Yahoo throttled — a true outage, not a slow crawl.

Cadence: weekly (same rationale as the marketsmojo trio — vendors restate quarterly figures
around results days; a weekly pass converges, and 45-day warn windows fit any future DQ check).

Runs under the repo venv but SPAWNS the server via PATH's `python` (where finstack is
installed); override with --server-cmd or MCP_SERVER_CMD if the layout differs.

Run:
  python finstack_cashflow_fetcher.py                # weekly incremental: skip symbols checked
                                                     # within 90d, then a date-rotated batch of
                                                     # 250 (Yahoo quarterly + ET annual fallback)
  python finstack_cashflow_fetcher.py --symbols INFY # explicit list bypasses skip AND batch cap
  python finstack_cashflow_fetcher.py --limit 50 --workers 3
  python finstack_cashflow_fetcher.py --max-fetch 0  # 0 = uncapped batch (full-universe backfill)

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
from datetime import datetime, timedelta, timezone

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

# AF-20260912-14. The per-thread `time.sleep(2)` this replaces left 5 of 6 workers hammering
# while one slept — the run tripped Yahoo's throttle in minutes and aborted at 25, failing the
# ml-weekly-retrain verdict three weeks running (09-10/09-11/09-12). The governor is
# process-wide: the FIRST throttle cools every worker (30s, doubling per sustained throttle,
# capped at 120s). THROTTLE_BUDGET_SEC bounds the total patience: once 15 cumulative minutes
# have gone to cooldowns the vendor is refusing at drip pace too, and aborting is cheaper than
# burning the step's remaining 40-min budget. The count threshold above stays as the fast path.
THROTTLE_COOLDOWN_BASE_SEC = 30.0
THROTTLE_COOLDOWN_CAP_SEC = 120.0
THROTTLE_BUDGET_SEC = 900.0

# Quarterly data restates ~4x/year (results days); a symbol cleanly answered within 90d is
# skipped — same window the marketsmojo trio uses for the same reason (AF-20260909-15). The
# marker (NOT finstack_cashflow_history) is the freshness source: most of the universe is a
# clean "Yahoo has no coverage" that writes NO history rows, so a history-derived skip would
# re-crawl it forever — the exact bug mf_holdings_fetcher.py measured at 44% of its universe.
STALENESS_DAYS = 90

# Cap on symbols attempted per run (after the staleness skip), rotated by date so consecutive
# runs advance through the pending universe instead of always re-trying its head. 250 × ~1.5s
# at 6 workers ≈ 1 min uncontended; at Yahoo's observed refusal pace the batch still converges
# over ~8 runs instead of restarting from zero each week. 0 disables the cap (manual backfill).
MAX_FETCH_PER_RUN = 250


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


class ThrottleGovernor:
    """Process-wide cooldown shared by every worker thread (AF-20260912-14).

    Yahoo throttles per client, not per request: while the old code had each throttled
    thread sleep 2s alone, its 5 siblings kept issuing calls into the same refusal. The
    governor cools the WHOLE pool on the first throttle, escalating geometrically while the
    vendor keeps refusing, and tracks cumulative cooldown so the run can give up on a
    measured budget instead of an unmeasured symbol count alone.
    """

    def __init__(self, base: float = THROTTLE_COOLDOWN_BASE_SEC,
                 cap: float = THROTTLE_COOLDOWN_CAP_SEC,
                 budget: float = THROTTLE_BUDGET_SEC):
        self._base, self._cap, self._budget = base, cap, budget
        self._lock = threading.Lock()
        self._next_allowed = 0.0        # time.monotonic() of the pool-wide green light
        self._strikes = 0
        self._cooldown_spent = 0.0

    def on_throttle(self) -> float:
        """Register one throttled call. Returns the cumulative cooldown seconds spent."""
        with self._lock:
            self._strikes += 1
            wait = min(self._cap, self._base * (2 ** (self._strikes - 1)))
            self._cooldown_spent += wait
            self._next_allowed = max(self._next_allowed, time.monotonic()) + wait
            return self._cooldown_spent

    def budget_exhausted(self) -> bool:
        with self._lock:
            return self._cooldown_spent >= self._budget

    def wait(self) -> None:
        """Block until the pool-wide green light. No-op while the vendor is not throttling."""
        with self._lock:
            t = self._next_allowed
        remaining = t - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)


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
    # AF-20260912-14: per-symbol "we already asked the vendor" marker. The history table
    # cannot serve this role (no rows for no-coverage names), exactly the shape the
    # marketsmojo_financials_checked migration documents. `verdict` records WHAT the vendor
    # answered ('ok' = data written, 'empty' = clean no-coverage) so a future change to the
    # skip policy doesn't have to guess which symbols were genuinely answered.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS finstack_cashflow_checked (
            symbol      TEXT PRIMARY KEY,
            verdict     TEXT NOT NULL,
            checked_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)
    con.commit()


def load_recently_checked(con, staleness_days: int = STALENESS_DAYS) -> set[str]:
    """Symbols cleanly answered (ok OR empty) within the staleness window — skip these.

    Degrades toward MORE work (empty set) on any read failure, mirroring
    test_rate_limit_vs_no_coverage.py's rule: a broken skip-list must fetch the whole
    universe, never silently fetch nothing.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=staleness_days)).isoformat()
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT symbol FROM finstack_cashflow_checked WHERE checked_at >= ?", (cutoff,))
        return {r[0] for r in cur.fetchall()}
    except Exception as exc:
        print(f"[FCH] checked-marker read failed ({exc}); fetching everything", file=sys.stderr)
        return set()


def mark_checked(con, symbol: str, verdict: str) -> None:
    """Record one cleanly-answered symbol. Throttled/aborted symbols must NEVER reach
    here — their absence is what makes the next run retry them."""
    cur = con.cursor()
    cur.execute("""
        INSERT INTO finstack_cashflow_checked (symbol, verdict, checked_at)
        VALUES (?, ?, ?)
        ON CONFLICT (symbol) DO UPDATE SET verdict = excluded.verdict,
                                           checked_at = excluded.checked_at
    """, (symbol, verdict, datetime.now(timezone.utc).isoformat()))
    con.commit()


def rotation_window(symbols: list[str], cap: int, day_number: int) -> list[str]:
    """The date-rotated batch: `cap` symbols starting at an offset that advances by `cap`
    per day. Deterministic in (sorted universe, cap, day) so a rerun the same day repeats
    the same batch, and consecutive days tile the whole pending universe in ~len/cap days
    — a symbol aborted by a throttle is retried within that cycle, not restarted from zero
    next week. Pure."""
    if not symbols:
        return []
    if cap <= 0 or cap >= len(symbols):
        return list(symbols)
    offset = (day_number * cap) % len(symbols)
    return [symbols[(offset + i) % len(symbols)] for i in range(cap)]


def should_exit_nonzero(stats: dict) -> bool:
    """The step verdict rule (AF-20260912-14). A throttled Yahoo pass that still wrote
    SOMETHING — quarterly rows from Yahoo, or annual rows via the ET fallback — made
    progress and must not fail the weekly job again; the DEGRADED stderr note keeps the
    throttle visible to the digest. Exit 1 only for the true outage: throttled AND not a
    single row written anywhere. Pure."""
    wrote_anything = bool(stats.get("written")) or bool(stats.get("et_rows"))
    return bool(stats.get("rate_limited")) and not wrote_anything


def et_fallback_fetch(symbols: list[str], con, stats: dict) -> int:
    """Fill `et_cashflow_history` (annual CFO/CFI/CFF) for `symbols` via the ET_Stats
    CashFlow piggyback financial_ratios_fetcher.py already ships — parse_cashflow_series()
    + upsert_cashflow_history() are imported, NOT duplicated, so both writers stay one
    implementation (the mf_holdings rule: two writers racing on one table is never a win).
    ET answers this host cleanly where Yahoo throttles (live-probed 2026-09-12), giving the
    platform real cash-flow coverage while the Yahoo quarterly pass converges slowly.

    Annual and quarterly live in SEPARATE tables by design: different period semantics and
    units, and ml_ensemble must never read a series that silently mixes both.

    Returns annual rows written. Any fallback failure is contained: a dead fallback must
    not turn a Yahoo pass that wrote data into a failed run."""
    if not symbols:
        return 0
    try:
        import requests
        from financial_ratios_fetcher import (
            HEADERS, ensure_schema as ensure_fr_schema,  # noqa: E402
            fetch_et_stats, load_companyid_map,         # noqa: E402
            parse_cashflow_series, upsert_cashflow_history,  # noqa: E402
        )
    except Exception as exc:
        print(f"[FCH] ET fallback unavailable ({exc}); skipping annual fill", file=sys.stderr)
        return 0
    company_map = load_companyid_map()
    session = requests.Session()
    session.headers.update(HEADERS)
    ensure_fr_schema(con)
    written = 0
    fetched = 0
    for sym in symbols:
        cid = company_map.get(sym)
        if not cid:
            continue
        try:
            rows = parse_cashflow_series(fetch_et_stats(cid, "CashFlow", session, last=6))
        except Exception as exc:
            print(f"[FCH] {sym}: ET fallback error ({exc}); skipped", file=sys.stderr)
            continue
        fetched += 1
        if rows:
            upsert_cashflow_history(sym, rows, con)
            written += len(rows)
        # fetch_et_stats already paces (RATE_LIMIT_SEC) and returns None on failure —
        # an ET outage here degrades to "fewer annual rows", never to a crash.
    stats["et_symbols"] = fetched
    stats["et_rows"] = written
    return written


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


def yahoo_ticker(symbol: str) -> str:
    """NSE symbol -> the Yahoo ticker that identifies the NSE listing.

    MANDATORY, not cosmetic. finstack wraps yfinance, and a BARE NSE symbol does not
    resolve to the NSE listing on Yahoo — it resolves to whatever US-listed company owns
    that ticker, or 404s. Live-probed 2026-09-12: IEX -> IDEX Corporation (NYSE),
    CUB -> Lionheart Holdings, HAL -> Halliburton; only `.NS` returns Indian Energy
    Exchange / City Union Bank / Hindustan Aeronautics. Sending the bare symbol wrote 13
    foreign companies' cash-flow statements into this table under NSE tickers, and 404'd
    the other ~2,000 names (AF-20260912-01). `data-sources.md`: Yahoo's id IS
    `symbol + ".NS"`, derived inline — never the bare symbol."""
    return f"{symbol}.NS"


def fetch_symbol(mcp: McpStdioClient, symbol: str) -> list[dict]:
    """Call finstack cash_flow(quarterly=true) for one symbol and parse the envelope.
    Returns [] on business-error envelope, malformed payload, or empty vendor coverage —
    missing data is the expected common case, not an exception-worthy event. Raises
    McpError on transport/protocol trouble (timeout, wedged or dead channel); run()
    recycles the channel in that case and honest-skips the symbol.

    Queries the `.NS` ticker but the caller stores under the plain NSE symbol — the NSE
    symbol stays this platform's canonical identifier (`data-sources.md`)."""
    text = mcp.call_tool("cash_flow", {"symbol": yahoo_ticker(symbol), "quarterly": True})
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
        stats: dict | None = None, max_fetch: int | None = None,
        et_fallback: bool = True) -> int:
    """Returns the number of symbols written (unchanged contract).

    `stats`, when passed, is populated with the run's honest outcome breakdown
    (written / empty / rate_limited / aborted / et_rows) so main() can decide the exit
    code via should_exit_nonzero() instead of reporting a clean success over an empty
    result.

    `max_fetch` caps the batch attempted this run AFTER the staleness skip (0 = uncapped);
    `et_fallback` controls the annual ET fill (et_cashflow_history) for the same batch.
    An explicit `symbols` list bypasses both the skip and the cap — "I want these now"."""
    t0 = time.time()
    universe = load_universe(symbols, limit)
    if not universe:
        print("[FCH] nothing to fetch (empty universe).")
        return 0

    con = connect()
    ensure_schema(con)

    # AF-20260912-14 incremental mode: skip what the vendor cleanly answered within the
    # staleness window, then take this run's date-rotated batch. An explicit symbol list
    # means "fetch these now" — no skip, no cap.
    explicit_symbols = bool(symbols)
    if not explicit_symbols:
        recently = load_recently_checked(con)
        if recently:
            universe = [s for s in universe if s not in recently]
            print(f"[FCH] staleness skip: {len(recently)} symbol(s) answered within "
                  f"{STALENESS_DAYS}d — {len(universe)} pending.")
        cap = MAX_FETCH_PER_RUN if max_fetch is None else max_fetch
        batch = rotation_window(universe, cap, datetime.now(timezone.utc).toordinal())
        if len(batch) < len(universe):
            print(f"[FCH] batch cap {cap}: fetching {len(batch)} of {len(universe)} "
                  f"pending symbols (rotation advances daily).")
    else:
        batch = universe
    if not batch:
        print("[FCH] nothing pending (all symbols within the staleness window).")
        if stats is not None:
            stats.update(universe=len(universe), written=0, empty=0, rate_limited=0,
                         aborted=0, recycled=0, checked_skipped=len(universe), et_rows=0)
        return 0

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
    governor = ThrottleGovernor()
    answered: list[tuple[str, str]] = []  # (symbol, verdict) for the checked-marker write

    def _task(sym: str) -> tuple[str, list[dict], str]:
        nonlocal recycled, rate_limited
        # Once the vendor is refusing the run, stop issuing calls. Remaining symbols are
        # reported as skipped-by-abort, never as "no vendor coverage".
        if abort.is_set():
            return sym, [], 'aborted'
        # Pool-wide green light (AF-20260912-14): during a throttle, EVERY worker waits
        # here instead of hammering on — the old per-thread 2s sleep cooled one thread
        # while its five siblings kept feeding the refusal.
        governor.wait()
        client = client_queue.get()
        try:
            rows = fetch_symbol(client, sym)
        except RateLimited as exc:
            client_queue.put(client)  # channel is healthy; the VENDOR said no
            with lock:
                rate_limited += 1
                n = rate_limited
            spent = governor.on_throttle()
            if n <= 3:
                print(f"[FCH] {sym}: vendor rate-limited ({exc}) — pool cooldown active",
                      file=sys.stderr)
            if not abort.is_set() and (n >= RATE_LIMIT_ABORT_THRESHOLD
                                       or governor.budget_exhausted()):
                abort.set()
                print(f"[FCH] ABORTING after {n} throttles / {spent:.0f}s cumulative "
                      f"cooldown — the vendor is refusing this run at drip pace too; "
                      f"unattempted symbols stay unmarked in the checked table and rotate "
                      f"back on a later run. The ET annual fallback still fills the batch.",
                      file=sys.stderr)
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
            futures = {pool.submit(_task, s): s for s in batch}
            for fut in as_completed(futures):
                sym, rows, outcome = fut.result()
                with lock:
                    done += 1
                    if outcome == 'ok':
                        upsert_cashflow(sym, rows, con)
                        written += 1
                        answered.append((sym, 'ok'))
                    elif outcome == 'empty':
                        # ONLY a clean vendor answer with no periods counts as "no coverage".
                        empty += 1
                        answered.append((sym, 'empty'))
                    elif outcome == 'aborted':
                        aborted += 1
                    # 'rate_limited' / 'mcp_error' are already counted in their handlers —
                    # and deliberately NEVER enter `answered`: their absence from the
                    # checked table is what makes a later run retry them.
                    if done % 100 == 0:
                        print(f"[FCH] {done}/{len(batch)} symbols ({written} with data, "
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

    # AF-20260912-14: only cleanly-answered symbols enter the skip marker. Throttled,
    # aborted, and channel-error symbols stay unmarked so the rotation retries them.
    for sym, verdict in answered:
        try:
            mark_checked(con, sym, verdict)
        except Exception as exc:
            print(f"[FCH] {sym}: checked-marker write failed ({exc}); "
                  f"it will be retried", file=sys.stderr)

    # ET annual fallback for this run's batch (Yahoo-covered names included — the two
    # vendors' coverage sets disagree, and the tables are separate so nothing mixes).
    et_rows = 0
    if et_fallback:
        try:
            et_rows = et_fallback_fetch(batch, con, stats if stats is not None else {})
        except Exception as exc:
            # Contained by design inside et_fallback_fetch too; this belt-and-suspenders
            # guard keeps a dead fallback from failing a Yahoo pass that wrote data.
            print(f"[FCH] ET fallback failed ({exc}); annual fill skipped", file=sys.stderr)

    print(f"[FCH] done: {written}/{len(batch)} symbols wrote quarterly cash-flow, "
          f"{empty} had no vendor coverage, {rate_limited} rate-limited, {aborted} skipped "
          f"after abort, {recycled} channel recycles, {et_rows} annual ET rows "
          f"({time.time() - t0:.1f}s).")
    if stats is not None:
        stats.update(universe=len(universe), written=written, empty=empty,
                     rate_limited=rate_limited, aborted=aborted, recycled=recycled,
                     et_rows=stats.get("et_rows", 0) or et_rows)
    if rate_limited:
        # stderr, not stdout: runPython() only inspects stderr to flag a run as degraded
        # (see recurring-bugs.md's degraded-read-print-to-stdout entry). Still emitted even
        # when the run now exits 0 (progress was made) so the digest keeps seeing it.
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
    parser.add_argument("--max-fetch", type=int, default=MAX_FETCH_PER_RUN,
                        help="cap symbols attempted this run after the staleness skip "
                             "(rotation advances daily; 0 = uncapped manual backfill)")
    parser.add_argument("--et-fallback", action=argparse.BooleanOptionalAction, default=True,
                        help="also fill et_cashflow_history (annual CFO/CFI/CFF) for this "
                             "run's batch via financial_ratios_fetcher's ET_Stats harvest")
    args = parser.parse_args()

    sym_filter = [s.strip() for s in args.symbols.split(",")] if args.symbols else None
    cmd = args.server_cmd.split() if args.server_cmd else None
    stats: dict = {}
    run(symbols=sym_filter, limit=args.limit, workers=args.workers, server_cmd=cmd,
        stats=stats, max_fetch=args.max_fetch, et_fallback=args.et_fallback)
    # AF-20260912-14 verdict rule (should_exit_nonzero): exit 1 ONLY when Yahoo throttled
    # the run AND not a single row was written anywhere (Yahoo quarterly or ET annual) —
    # a true outage. A throttled run that still made progress exits 0; its DEGRADED stderr
    # note keeps the throttle visible to jobSweep/digest. Returning 0 over a throttled
    # EMPTY result is still impossible — that is the AF-20260910-06 bug this rule preserves.
    return 1 if should_exit_nonzero(stats) else 0


if __name__ == "__main__":
    sys.exit(main())

