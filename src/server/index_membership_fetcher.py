#!/usr/bin/env python3
"""Fetch NSE constituent CSVs for major indices and store membership flags per stock.

Passive ETF flows (₹2L+ Cr AUM in Nifty 50 ETFs) are predictable at index
rebalancing — index membership is a structural demand signal.

Run daily (queues.ts: index-membership-daily, weekdays 15:35 UTC / 21:05 IST) so every
trading day's technical_signals row gets blessed same-day -- see backfill_technical_signals()'s
own comment (AF-20260828-21) for why a weekly-only cadence left is_nifty50/etc. at the column's
raw schema default (0, indistinguishable from "confirmed not a member") on 4-5 of every 5
trading days. Also still invoked from nse-sync-weekly (Saturday) as a redundant safety net --
harmless, the fetcher is idempotent.

Manual run: python index_membership_fetcher.py
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class IndexMembershipFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class IndexMembershipFetcherBaseFetcher(BaseFetcher[IndexMembershipFetcherSchema]):
    fetcher_name = 'IndexMembershipFetcher'
    domain = 'general'
    schema = IndexMembershipFetcherSchema
    min_interval_sec = 0.5

from datetime import datetime
import io
import requests
import pandas as pd
from db_compat import connect, use_postgres
from as_of import logical_write_floor
import sys

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://www.nseindia.com/",
}

INDICES = {
    "NIFTY50":          "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv",
    "NIFTY100":         "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv",
    "NIFTY200":         "https://nsearchives.nseindia.com/content/indices/ind_nifty200list.csv",
    "NIFTYMIDCAP150":   "https://nsearchives.nseindia.com/content/indices/ind_niftymidcap150list.csv",
    "NIFTYSMALLCAP250": "https://nsearchives.nseindia.com/content/indices/ind_niftysmallcap250list.csv",
}

# Column name → (nse_stocks flag column, tier value)
INDEX_META = {
    "NIFTY50":          ("is_nifty50",     50),
    "NIFTY100":         ("is_nifty100",    100),
    "NIFTY200":         ("is_nifty200",    200),
    "NIFTYMIDCAP150":   ("is_midcap150",   150),
    "NIFTYSMALLCAP250": ("is_smallcap250", 250),
}


def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get("https://www.nseindia.com/", timeout=10)
    return s


def fetch_index_symbols(sess: requests.Session, index_name: str, url: str) -> set[str]:
    """Fetch a single NSE index CSV and return the set of NSE symbols."""
    try:
        r = sess.get(url, timeout=15)
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text), engine="python", on_bad_lines="skip")
        sym_col = next(
            (c for c in df.columns if c.strip().lower() == "symbol"),
            None,
        )
        if sym_col is None:
            # Fallback: any column whose name contains "symbol"
            sym_col = next((c for c in df.columns if "symbol" in c.lower()), None)
        if sym_col is None:
            print(f"[IndexMembership] {index_name}: no Symbol column in CSV (cols={list(df.columns)})")
            return set()
        symbols = set(df[sym_col].dropna().str.upper().str.strip())
        symbols.discard("")
        return symbols
    except Exception as e:
        print(f"[IndexMembership] {index_name}: fetch failed — {e}", file=sys.stderr)
        return set()


def ensure_schema(con) -> None:
    """Add index-membership columns to nse_stocks and technical_signals if absent."""
    cur = con.cursor()

    nse_stocks_ddls = [
        "ALTER TABLE nse_stocks ADD COLUMN is_nifty50       INTEGER DEFAULT 0",
        "ALTER TABLE nse_stocks ADD COLUMN is_nifty100      INTEGER DEFAULT 0",
        "ALTER TABLE nse_stocks ADD COLUMN is_nifty200      INTEGER DEFAULT 0",
        "ALTER TABLE nse_stocks ADD COLUMN is_midcap150     INTEGER DEFAULT 0",
        "ALTER TABLE nse_stocks ADD COLUMN is_smallcap250   INTEGER DEFAULT 0",
        "ALTER TABLE nse_stocks ADD COLUMN index_flags_updated_at TEXT",
    ]
    technical_signals_ddls = [
        "ALTER TABLE technical_signals ADD COLUMN is_nifty50       INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN is_nifty100      INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN is_nifty200      INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN is_midcap150     INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN is_smallcap250   INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN nifty_tier       INTEGER",
    ]

    for ddl in nse_stocks_ddls + technical_signals_ddls:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


def update_nse_stocks(con, memberships: dict[str, set[str]]) -> dict[str, int]:
    """Reset all flags, then set them per index. Returns {index_name: count_updated}."""
    cur = con.cursor()
    today = datetime.utcnow().date().isoformat()

    # Full refresh — reset all flags before applying new lists
    cur.execute(
        "UPDATE nse_stocks SET "
        "is_nifty50 = 0, is_nifty100 = 0, is_nifty200 = 0, "
        "is_midcap150 = 0, is_smallcap250 = 0"
    )
    con.commit()

    counts: dict[str, int] = {}
    for index_name, symbols in memberships.items():
        if not symbols:
            counts[index_name] = 0
            continue
        col, _ = INDEX_META[index_name]
        if not symbols:
            counts[index_name] = 0
            continue

        if use_postgres():
            # Bulk update via ANY
            cur.execute(
                f"UPDATE nse_stocks SET {col} = 1, index_flags_updated_at = ? "
                f"WHERE symbol = ANY(?)",
                (today, list(symbols)),
            )
        else:
            placeholders = ",".join("?" * len(symbols))
            cur.execute(
                f"UPDATE nse_stocks SET {col} = 1, index_flags_updated_at = ? "
                f"WHERE symbol IN ({placeholders})",
                [today] + list(symbols),
            )
        counts[index_name] = cur.rowcount

    con.commit()
    return counts


def backfill_technical_signals(con) -> int:
    """Copy index flags + compute nifty_tier from nse_stocks → technical_signals."""
    cur = con.cursor()

    # date >= today ELSE NULL guard added 2026-07-19 -- this previously used plain `=` with NO
    # date filter (worse than COALESCE: REWRITES every historical row on every run, so index
    # membership never reflected true historical status, only "whatever it is today"). No
    # historical index-membership snapshot exists to backfill from, so older rows are
    # explicitly nulled rather than left holding today's status.
    #
    # Anchor to the last completed trading session, NOT datetime.now() -- nse-sync-weekly
    # (queues.ts) runs this fetcher Saturday 2:00 AM UTC / 7:30 AM IST, a non-trading day with
    # no technical_signals row yet for today's wall-clock date. A bare datetime.now() floor
    # would match zero existing rows there, NULLing every historical is_nifty50/.../nifty_tier
    # column on every single run -- same bug class already fixed in asm_gsm_fetcher.py,
    # financial_ratios_fetcher.py, and 7 other fetchers (see CLAUDE.md "date('now') anchor"
    # recurring-bug notes). logical_write_floor() correctly resolves to the prior Friday there.
    #
    # AF-20260828-21: this same date-guard, correct in isolation, meant the job only ever
    # blessed the ONE trading-day row it happened to run on -- weekly cadence left every OTHER
    # trading day's row at the column's raw schema default (0) until the following week. Fixed
    # by also running this fetcher daily (queues.ts: index-membership-daily, weekdays), not by
    # touching this guard -- the guard itself was never wrong.
    today = logical_write_floor(cur, fallback=datetime.now().strftime("%Y-%m-%d"))
    if use_postgres():
        cur.execute(
            """
            UPDATE technical_signals
            SET
                is_nifty50     = CASE WHEN technical_signals.date >= ? THEN ns.is_nifty50     ELSE NULL END,
                is_nifty100    = CASE WHEN technical_signals.date >= ? THEN ns.is_nifty100    ELSE NULL END,
                is_nifty200    = CASE WHEN technical_signals.date >= ? THEN ns.is_nifty200    ELSE NULL END,
                is_midcap150   = CASE WHEN technical_signals.date >= ? THEN ns.is_midcap150   ELSE NULL END,
                is_smallcap250 = CASE WHEN technical_signals.date >= ? THEN ns.is_smallcap250 ELSE NULL END,
                nifty_tier     = CASE WHEN technical_signals.date >= ? THEN
                    CASE
                        WHEN ns.is_nifty50     = 1 THEN 50
                        WHEN ns.is_nifty100    = 1 THEN 100
                        WHEN ns.is_nifty200    = 1 THEN 200
                        WHEN ns.is_midcap150   = 1 THEN 150
                        WHEN ns.is_smallcap250 = 1 THEN 250
                        ELSE 0
                    END
                ELSE NULL END
            FROM nse_stocks ns
            WHERE technical_signals.symbol = ns.symbol
            """,
            (today, today, today, today, today, today),
        )
    else:
        cur.execute(
            """
            UPDATE technical_signals
            SET
                is_nifty50     = CASE WHEN date >= ? THEN (SELECT is_nifty50     FROM nse_stocks WHERE symbol = technical_signals.symbol) ELSE NULL END,
                is_nifty100    = CASE WHEN date >= ? THEN (SELECT is_nifty100    FROM nse_stocks WHERE symbol = technical_signals.symbol) ELSE NULL END,
                is_nifty200    = CASE WHEN date >= ? THEN (SELECT is_nifty200    FROM nse_stocks WHERE symbol = technical_signals.symbol) ELSE NULL END,
                is_midcap150   = CASE WHEN date >= ? THEN (SELECT is_midcap150   FROM nse_stocks WHERE symbol = technical_signals.symbol) ELSE NULL END,
                is_smallcap250 = CASE WHEN date >= ? THEN (SELECT is_smallcap250 FROM nse_stocks WHERE symbol = technical_signals.symbol) ELSE NULL END,
                nifty_tier     = CASE WHEN date >= ? THEN
                    CASE
                        WHEN (SELECT is_nifty50     FROM nse_stocks WHERE symbol = technical_signals.symbol) = 1 THEN 50
                        WHEN (SELECT is_nifty100    FROM nse_stocks WHERE symbol = technical_signals.symbol) = 1 THEN 100
                        WHEN (SELECT is_nifty200    FROM nse_stocks WHERE symbol = technical_signals.symbol) = 1 THEN 200
                        WHEN (SELECT is_midcap150   FROM nse_stocks WHERE symbol = technical_signals.symbol) = 1 THEN 150
                        WHEN (SELECT is_smallcap250 FROM nse_stocks WHERE symbol = technical_signals.symbol) = 1 THEN 250
                        ELSE 0
                    END
                ELSE NULL END
            """,
            (today, today, today, today, today, today),
        )

    updated = cur.rowcount
    con.commit()
    return updated


def main():
    print("[IndexMembership] Fetching NSE index constituent lists...")
    sess = _nse_session()

    memberships: dict[str, set[str]] = {}
    for index_name, url in INDICES.items():
        symbols = fetch_index_symbols(sess, index_name, url)
        memberships[index_name] = symbols
        print(f"[IndexMembership] {index_name}: {len(symbols)} symbols")

    con = connect()
    ensure_schema(con)

    counts = update_nse_stocks(con, memberships)
    ts_updated = backfill_technical_signals(con)
    con.close()

    n50  = counts.get("NIFTY50", 0)
    n100 = counts.get("NIFTY100", 0)
    n200 = counts.get("NIFTY200", 0)
    mid  = counts.get("NIFTYMIDCAP150", 0)
    sml  = counts.get("NIFTYSMALLCAP250", 0)

    print(
        f"[IndexMembership] Nifty50={n50}, Nifty100={n100}, Nifty200={n200}, "
        f"Midcap150={mid}, Smallcap250={sml} -> technical_signals updated ({ts_updated} rows)"
    )


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
