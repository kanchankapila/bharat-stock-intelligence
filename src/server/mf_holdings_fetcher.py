#!/usr/bin/env python3
"""Fetch mutual fund holding % per stock and store for ML features.

REWRITTEN 2026-08-13: the previous source (mfapps.indiatimes.com's MFPortfolioHolding.cms,
keyed by bse/nse code) is dead -- confirmed live, returns a clean nginx 404 for every symbol,
upstream retired. It had produced zero rows since the fetcher was added; every scheduled run
was ~200 requests that all 404'd. Replaced with ET's shareholding-pattern endpoint
(marketservices.indiatimes.com), keyed by the same ET `companyid` the ET_Stats fetchers already
use (scripts/stocklist.json via load_companyid_map()) -- confirmed live against RELIANCE/
HDFCBANK/BEL, real quarterly promoter/FII/DII/MF/pledge shareholding data.

  Source: https://marketservices.indiatimes.com/marketservices/shareholding?companyid={cid}
  summary.mf.percentage = MF holding % of the stock (as of the latest disclosed quarter)
  summary.mf.changeQoQ  = change vs the prior quarter

This endpoint has no per-fund count (no_of_funds) -- that metric is NOT reconstructed here.
mf_stock_holdings_fetcher.py (a separate, healthy fetcher/table) already covers fund-count and
share-level MF flow via technical_signals.mf_fund_count; duplicating it here would just be two
writers racing on the same column for no benefit. This fetcher's sole job is the ownership
LEVEL (mf_holding_pct) and its QoQ change (chg_vs_prev) -- the one metric nothing else on the
platform captures.

Writes to stock_mf_holdings (symbol, date, mf_holding_pct, chg_vs_prev).
Joins into technical_signals (mf_holding_pct, mf_chg_vs_prev), point-in-time gated: shareholding
disclosures are quarterly SEBI filings that lag the quarter-end by SHAREHOLDING_DISCLOSURE_LAG_DAYS
(30 = SEBI's 21-day mandatory filing deadline + ~9 days of ET aggregation lag; live-checked
2026-08-13 that the Jun-30 quarter's data was already available 44 days out, so 30 is
conservative without being needlessly so -- not independently verified against a real per-
company filing-date table the way MF_DISCLOSURE_LAG_DAYS=14 is in mf_stock_holdings_fetcher.py;
tighten if a real lag is ever measured).

Run weekly (shareholding patterns only change once a quarter; weekly is a generous crawl cadence).

Usage:
    python mf_holdings_fetcher.py
    python mf_holdings_fetcher.py --symbol RELIANCE
    python mf_holdings_fetcher.py --limit 50
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class MfHoldingsFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class MfHoldingsFetcherBaseFetcher(BaseFetcher[MfHoldingsFetcherSchema]):
    fetcher_name = 'MfHoldingsFetcher'
    domain = 'amfiindia.com'
    schema = MfHoldingsFetcherSchema
    min_interval_sec = 0.5

import argparse
import time
from datetime import date, timedelta

import requests

from db_compat import connect
from et_stats_client import HEADERS, load_companyid_map
import sys

RATE_LIMIT_SEC = 0.3

# Quarterly SEBI filings restate ~4x/year; SHAREHOLDING_DISCLOSURE_LAG_DAYS=30 already models
# the filing lag. 80 days is comfortably inside a quarter, so a genuinely-new disclosure is still
# picked up on the next weekly run, while unchanged symbols are skipped instead of recrawled.
STALENESS_DAYS = 80
# How long a genuinely-empty verdict suppresses a symbol. Measured 2026-09-10: of a
# 2,366-name universe only 1,403 have EVER been written, so 1,037 (44%) were re-crawled on
# every run forever -- they can never enter a skip list built from successful writes, which is
# what grew this job past its 20-minute budget. 90d matches the quarterly disclosure cadence,
# so a stock that newly attracts MF money is still picked up within one quarter.
NO_COVERAGE_TTL_DAYS = 90
# Abort once the vendor is clearly rate-limiting rather than burning the rest of the universe
# on requests that cannot succeed (and keeping the throttle warm). Errors are counted
# separately from empties precisely so this is measurable.
MAX_CONSECUTIVE_ERRORS = 25
# Flush size for the incremental upsert (see main()).
FLUSH_EVERY = 100
SHAREHOLDING_URL = "https://marketservices.indiatimes.com/marketservices/shareholding?companyid={cid}"
SHAREHOLDING_DISCLOSURE_LAG_DAYS = 30


# Verdicts. Only EMPTY is evidence about the stock; ERROR is evidence about the vendor.
# Collapsing them (the pre-2026-09-10 behaviour: a bare `None` for all three of non-200,
# clean-but-empty, and exception) is what makes a negative cache dangerous -- see
# `.claude/rules/recurring-bugs.md`, "a THROTTLED vendor response and a genuinely-empty one
# must not collapse to the same value". Caching a 429 as "this stock has no MF holdings"
# converts a transient rate-limit into silent, permanent data loss.
VERDICT_OK, VERDICT_EMPTY, VERDICT_ERROR = "ok", "empty", "error"


def is_cacheable_verdict(verdict: str) -> bool:
    """Only a clean 200 that genuinely carried no MF holdings may enter the negative cache."""
    return verdict == VERDICT_EMPTY


def fetch_mf_holding(symbol: str, company_id: str,
                     session: requests.Session) -> tuple[str, dict | None]:
    """Return (verdict, payload). See VERDICT_* above for why this is not a bare Optional."""
    try:
        r = session.get(SHAREHOLDING_URL.format(cid=company_id), timeout=10)
        if r.status_code != 200:
            # Includes 429. NOT evidence that the stock has no MF holdings.
            print(f"[MF] {symbol}: HTTP {r.status_code}", file=sys.stderr)
            return VERDICT_ERROR, None
        data = r.json()
        mf = (data.get("summary") or {}).get("mf") or {}
        if not mf or mf.get("percentage") is None:
            # A clean 200 that parsed fine and carried no MF holdings: the one cacheable case.
            return VERDICT_EMPTY, None
        # quarterDates[0] is {"date": <epoch-ms>, "dateStr": "30 Jun 2026"}, most-recent-first --
        # confirmed live 2026-08-13. Use the epoch field, not dateStr (locale-dependent format).
        quarter_dates = data.get("quarterDates") or []
        epoch_ms = quarter_dates[0].get("date") if quarter_dates else None
        as_of_date = date.fromtimestamp(epoch_ms / 1000).isoformat() if epoch_ms else None
        return VERDICT_OK, {
            "symbol": symbol,
            "mf_holding_pct": round(float(mf["percentage"]), 4),
            "chg_vs_prev": round(float(mf["changeQoQ"]), 4) if mf.get("changeQoQ") is not None else None,
            "as_of_date": as_of_date,
        }
    except Exception as e:
        # Transport failure, timeout, unparseable body: says nothing about the stock.
        print(f"[MF] {symbol}: {e}", file=sys.stderr)
        return VERDICT_ERROR, None


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_mf_holdings (
            symbol         TEXT NOT NULL,
            date           TEXT NOT NULL,
            mf_holding_pct REAL,
            num_funds      INTEGER,
            chg_vs_prev    REAL,
            fetched_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    # Commit the CREATE before the ALTERs below. Each of those fails once the column already
    # exists, and on Postgres a failed statement ABORTS THE WHOLE TRANSACTION -- so the
    # `except Exception: pass` swallows the error while the trailing commit() silently discards
    # this CREATE TABLE along with it. Harmless on a database where the table already exists,
    # which is why it survived; fatal on a fresh one, where stock_mf_holdings then never gets
    # created at all (caught 2026-08-16 running the live suite against an empty database).
    con.commit()
    # Columns on technical_signals
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_holding_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_fund_count INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS mf_chg_vs_prev REAL",
    ]:
        try:
            cur.execute(ddl)
        except Exception:
            pass
    con.commit()


def _floor(as_of_date: str | None, fallback: str) -> str:
    """Point-in-time floor: don't leak a shareholding figure onto rows dated before the
    disclosure was public. Same shape as mf_stock_holdings_fetcher.py's own _floor()."""
    try:
        d = date.fromisoformat(as_of_date[:10]) if as_of_date else None
    except (ValueError, TypeError):
        d = None
    if d:
        return (d + timedelta(days=SHAREHOLDING_DISCLOSURE_LAG_DAYS)).isoformat()
    return fallback


def upsert_holdings(rows: list[dict], today: str, con) -> None:
    cur = con.cursor()
    for r in rows:
        cur.execute("""
            INSERT INTO stock_mf_holdings (symbol, date, mf_holding_pct, chg_vs_prev)
            VALUES (?,?,?,?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                mf_holding_pct = excluded.mf_holding_pct,
                chg_vs_prev    = excluded.chg_vs_prev,
                fetched_at     = CURRENT_TIMESTAMP
        """, (r["symbol"], today, r["mf_holding_pct"], r.get("chg_vs_prev")))

        # Point-in-time: apply only to rows on/after the disclosure was public, NULL on older
        # rows -- across the symbol's whole history, not a single-date match (a bare
        # WHERE date = today silently touches 0 rows whenever this job runs on a non-trading
        # day with no matching technical_signals grid row yet; same bug class already fixed in
        # mf_stock_holdings_fetcher.py / financial_ratios_fetcher.py).
        floor = _floor(r.get("as_of_date"), fallback=today)
        cur.execute("""
            UPDATE technical_signals SET
                mf_holding_pct = CASE WHEN date >= ? THEN COALESCE(?, mf_holding_pct) ELSE NULL END,
                mf_chg_vs_prev = CASE WHEN date >= ? THEN COALESCE(?, mf_chg_vs_prev) ELSE NULL END
            WHERE symbol = ?
        """, (floor, r["mf_holding_pct"], floor, r.get("chg_vs_prev"), r["symbol"]))

    con.commit()


def ensure_no_coverage_schema(con) -> None:
    """Table recording symbols the vendor answered CLEANLY about, with no MF holdings."""
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mf_holdings_no_coverage (
            symbol     TEXT NOT NULL PRIMARY KEY,
            checked_at TEXT NOT NULL
        )
    """)
    con.commit()


def no_coverage_symbols(con, days: int) -> set[str]:
    """Symbols confirmed to have no MF holdings within `days`.

    Same degrade-toward-more-work contract as recently_fetched(): an unreadable cache must mean
    "fetch everything" (correct, just slower), never "skip everything".
    """
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT symbol FROM mf_holdings_no_coverage WHERE checked_at >= ?",
            ((date.today() - timedelta(days=days)).isoformat(),),
        )
        return {r[0] for r in cur.fetchall() if r and r[0]}
    except Exception as exc:  # noqa: BLE001 - degrade toward MORE work, not less
        print(f"[MF] no-coverage cache unavailable ({exc}); fetching the full universe",
              file=sys.stderr)
        return set()


def record_no_coverage(con, symbols: list[str]) -> None:
    """Persist genuinely-empty verdicts ONLY. Never call this for an error verdict."""
    if not symbols:
        return
    try:
        cur = con.cursor()
        today = date.today().isoformat()
        cur.executemany(
            "INSERT INTO mf_holdings_no_coverage (symbol, checked_at) VALUES (?, ?) "
            "ON CONFLICT (symbol) DO UPDATE SET checked_at = excluded.checked_at",
            [(sym, today) for sym in symbols],
        )
        con.commit()
    except Exception as exc:  # noqa: BLE001 - the cache is an optimisation, never load-bearing
        print(f"[MF] could not record no-coverage symbols ({exc})", file=sys.stderr)


def recently_fetched(con, days: int) -> set[str]:
    """Symbols already written to stock_mf_holdings within `days`.

    Returns an EMPTY SET on any error rather than raising: a failure to read the skip-list must
    degrade into "fetch everything" (correct, just slower), never into "skip everything"
    (silently writes nothing while reporting success)."""
    try:
        cur = con.cursor()
        cur.execute(
            "SELECT DISTINCT symbol FROM stock_mf_holdings "
            "WHERE date >= ?",
            ((date.today() - timedelta(days=days)).isoformat(),),
        )
        return {r[0] for r in cur.fetchall() if r and r[0]}
    except Exception as exc:  # noqa: BLE001 - see docstring: degrade toward MORE work, not less
        print(f"[MF] staleness skip unavailable ({exc}); fetching the full universe",
              file=sys.stderr)
        return set()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    ap.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    ap.add_argument("--no-skip", action="store_true",
                    help="Ignore the staleness skip and refetch every symbol")
    args = ap.parse_args()

    company_map = load_companyid_map()
    stocks = sorted(company_map.items())
    if args.symbol:
        stocks = [(s, c) for s, c in stocks if s == args.symbol.upper()]
    if args.limit:
        stocks = stocks[:args.limit]
    if not stocks:
        print("[MF] No stocks to fetch")
        return

    con = connect()
    ensure_schema(con)

    # AF-20260910-07. Shareholding patterns are QUARTERLY SEBI filings, but this ran a full
    # ~1,400-symbol recrawl every week: 1,400 x RATE_LIMIT_SEC is ~7min of pure sleep before a
    # single HTTP response is counted, against a 20-min budget with no headroom. It tipped over
    # on 2026-09-10 and, because the only upsert ran AFTER the loop, the entire run was lost
    # (nothing written for that date) -- the "step at the end of a script that gets killed by
    # its timeout never runs" class. Same fix shape as marketsmojo_financials (AF-20260909-15):
    # match the fetch cadence to the data cadence, so steady-state runs are a near-no-op.
    ensure_no_coverage_schema(con)
    if not args.symbol and not args.no_skip:
        fresh = recently_fetched(con, STALENESS_DAYS)
        # Symbols the vendor has cleanly told us have no MF holdings. Without this the 1,037
        # never-written names are re-crawled every run forever -- they cannot enter `fresh`,
        # which is built from successful WRITES.
        no_cov = no_coverage_symbols(con, NO_COVERAGE_TTL_DAYS)
        before = len(stocks)
        stocks = [(s, c) for s, c in stocks if s not in fresh and s not in no_cov]
        print(f"[MF] Skipping {before - len(stocks)}/{before} symbols "
              f"({len(fresh)} fetched within {STALENESS_DAYS}d, "
              f"{len(no_cov)} confirmed no-coverage within {NO_COVERAGE_TTL_DAYS}d); "
              f"{len(stocks)} to fetch.")
        if not stocks:
            print("[MF] Nothing stale enough to refetch — done.")
            con.close()
            return

    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()

    results = []
    pending = []
    empties = []          # genuinely-empty verdicts, safe to negative-cache
    saved = 0
    errors = 0            # vendor-side failures: NEVER cached
    consecutive_errors = 0
    aborted = False
    for i, (sym, company_id) in enumerate(stocks, 1):
        verdict, result = fetch_mf_holding(sym, company_id, session)
        if verdict == VERDICT_OK:
            consecutive_errors = 0
            results.append(result)
            pending.append(result)
            print(f"[MF] {sym}: {result['mf_holding_pct']:.2f}% (chg {result.get('chg_vs_prev')})")
        elif verdict == VERDICT_EMPTY:
            consecutive_errors = 0
            empties.append(sym)
            print(f"[MF] {sym}: no MF holdings (cached for {NO_COVERAGE_TTL_DAYS}d)")
        else:
            errors += 1
            consecutive_errors += 1
            print(f"[MF] {sym}: vendor error (not cached)")
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                # Continuing burns the rest of the universe on requests that cannot succeed and
                # keeps the throttle warm. Stop, keep what we have, and fail the step loudly.
                print(f"[MF] {consecutive_errors} consecutive vendor errors -- aborting to "
                      f"avoid burning the universe on a throttle.", file=sys.stderr)
                aborted = True
                break
        # Flush incrementally: a timeout-kill must not discard everything fetched so far.
        if len(pending) >= FLUSH_EVERY:
            upsert_holdings(pending, today, con)
            saved += len(pending)
            pending = []
            print(f"[MF] Flushed {saved} holdings so far")
        if i % 100 == 0:
            print(f"[MF] Progress: {i}/{len(stocks)}")
        time.sleep(RATE_LIMIT_SEC)

    # Only genuinely-empty verdicts. An error verdict must never land here.
    record_no_coverage(con, empties)

    if pending:
        upsert_holdings(pending, today, con)
        saved += len(pending)
    if saved:
        print(f"[MF] Saved {saved}/{len(stocks)} holdings to stock_mf_holdings")
    else:
        print("[MF] No data fetched")

    con.close()


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
