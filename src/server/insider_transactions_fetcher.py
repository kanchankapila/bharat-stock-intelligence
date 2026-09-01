#!/usr/bin/env python3
"""Fetch promoter/insider buying and selling from NSE corporate filings.

Promoter open-market buying is the strongest insider signal globally —
insiders only buy when they're highly confident. Selling is ambiguous
(liquidity reasons) but promoter buying at market is a strong directional
signal.

Run daily after market close:
    python insider_transactions_fetcher.py
    python insider_transactions_fetcher.py --symbol RELIANCE
    python insider_transactions_fetcher.py --days 180 --limit 100
"""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class InsiderTransactionsFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class InsiderTransactionsFetcherBaseFetcher(BaseFetcher[InsiderTransactionsFetcherSchema]):
    fetcher_name = 'InsiderTransactionsFetcher'
    domain = 'general'
    schema = InsiderTransactionsFetcherSchema
    min_interval_sec = 0.5

import sys
import argparse
import time
from datetime import datetime, timedelta, date

import requests

from db_compat import connect, translate, use_postgres
from fetch_utils import retry_get
from as_of import logical_trading_date
from insider_features import BUY_TYPES, SELL_TYPES

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/html",
    "Referer": "https://www.nseindia.com/",
}

NSE_INSIDER_URL = (
    "https://www.nseindia.com/api/corporates-pit"
    "?symbol={symbol}&from={from_date}&to={to_date}"
)

# NSE date format: DD-MM-YYYY
NSE_DATE_FMT = "%d-%m-%Y"

SLEEP_BETWEEN = 0.2  # seconds between per-symbol requests (NSE is low-latency; 0.3 was conservative)
BATCH_SIZE    = 15   # progress report every N symbols (NSE sessions are not thread-safe — stays sequential)


# ---------------------------------------------------------------------------
# NSE session (same pattern as asm_gsm_fetcher.py)
# ---------------------------------------------------------------------------

def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get("https://www.nseindia.com/", timeout=10)
    return s


# NSE expires the cookies handed out by the homepage warm-up partway through a long
# sequential run. Observed live on 2026-07-30: the run walked the universe alphabetically,
# succeeded through A–D, then EVERY symbol from "E" onward failed with a read timeout
# (96 E + 37 F + 27 G in one run, zero successes after) until the 30-minute job timeout
# killed it — so H–Z was never fetched at all, on every single run. The session was warmed
# exactly once at startup and never rebuilt, so one cookie expiry ended the whole run.
CONSECUTIVE_FAIL_LIMIT = 5    # rebuild the session after this many failures in a row
MAX_SESSION_REBUILDS   = 12   # then give up rather than loop forever against a hard block
REBUILD_BACKOFF_SEC    = 5.0


def _rebuild_session(attempt: int) -> requests.Session | None:
    """Fresh cookies after NSE stops answering. Returns None if NSE refuses the warm-up."""
    time.sleep(REBUILD_BACKOFF_SEC * attempt)
    try:
        sess = _nse_session()
        print(f"[INSIDER] NSE session rebuilt (attempt {attempt}/{MAX_SESSION_REBUILDS})")
        return sess
    except Exception as exc:
        print(f"[INSIDER] session rebuild {attempt} failed — {exc}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------

def ensure_schema(con) -> None:
    """Create insider_transactions table and add columns to technical_signals."""
    cur = con.cursor()

    # Main storage table
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS insider_transactions (
            symbol           TEXT NOT NULL,
            person_name      TEXT,
            person_category  TEXT,
            transaction_mode TEXT,
            quantity         REAL,
            value_cr         REAL,
            before_pct       REAL,
            after_pct        REAL,
            transaction_date TEXT NOT NULL,
            fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, person_name, transaction_date, transaction_mode)
        )
        """
    )
    con.commit()

    # Feature columns on technical_signals
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS promoter_buy_90d_cr  REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS promoter_sell_90d_cr REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS promoter_net_90d     REAL",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS insider_buy_flag     INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN IF NOT EXISTS insider_sell_flag    INTEGER DEFAULT 0",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ---------------------------------------------------------------------------
# NSE fetch
# ---------------------------------------------------------------------------

def fetch_nse_insider(
    sess: requests.Session,
    symbol: str,
    from_date: str,
    to_date: str,
) -> list[dict] | None:
    """Fetch insider trading records for one symbol from NSE.

    Returns the raw `data` array, or None if the request FAILED. None and [] are
    deliberately distinct: [] means "NSE answered, this stock has no filings" while None
    means "we never got an answer" — main() needs that difference to detect a dead session
    (see _refresh_session_if_stalled), and a caller that conflates them would silently treat
    a throttled run as a universe with no insider activity.
    """
    url = NSE_INSIDER_URL.format(
        symbol=symbol,
        from_date=from_date,
        to_date=to_date,
    )
    try:
        r = retry_get(sess, url, timeout=12)
        payload = r.json()
        return payload.get("data") or []
    except Exception as e:
        print(f"[INSIDER] {symbol}: fetch error after retries — {e}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Parse / normalise
# ---------------------------------------------------------------------------

def _parse_record(symbol: str, row: dict) -> dict | None:
    """Convert a raw NSE row into a normalised dict ready for DB insert."""
    try:
        person_name = (row.get("personName") or row.get("acqName") or row.get("name") or "").strip()
        person_category = (row.get("personCategory") or row.get("category") or "").strip()
        acq_mode = (row.get("acqMode") or row.get("mode") or "").strip()

        # Quantity
        qty_raw = row.get("secAcq") or row.get("secDis") or 0
        try:
            quantity = float(qty_raw)
        except (TypeError, ValueError):
            quantity = 0.0

        # Value → Cr  (NSE gives value in INR)
        val_raw = row.get("secVal") or row.get("value") or 0
        try:
            value_cr = float(val_raw) / 1e7
        except (TypeError, ValueError):
            value_cr = 0.0

        # Before / after shareholding % (2026-08-07 fix, dead-column sweep): the previous
        # version derived these as befAcqSharesNo/totSharesNo -- but NSE's real corporates-pit
        # response (live-verified, confirmed across RELIANCE/TCS/INFY/SUZLON/YESBANK) has NO
        # totSharesNo/totalShares field at all, so total_shares was always 0 and _pct()'s
        # `if t else None` guard made before_pct/after_pct 100% NULL forever (confirmed live,
        # 23,596/23,596 rows). NSE already supplies the percentage directly --
        # befAcqSharesPer/afterAcqSharesPer -- no ratio needs computing at all. Genuinely 0/
        # unpopulated for some filings (e.g. YESBANK, live-checked: 0/20 records had any
        # non-zero pct field) -- that's NSE's own filing data, not a parsing gap.
        def _pctfield(v):
            try:
                return round(float(v), 4)
            except (TypeError, ValueError):
                return None

        before_pct = _pctfield(row.get("befAcqSharesPer"))
        after_pct = _pctfield(row.get("afterAcqSharesPer"))

        # Transaction date — NSE returns ISO or DD-MMM-YYYY formats, sometimes with time
        raw_date = row.get("date") or row.get("transactionDate") or ""
        txn_date = _parse_date(raw_date)
        if not txn_date:
            return None

        return {
            "symbol": symbol.upper(),
            "person_name": person_name or None,
            "person_category": person_category or None,
            "transaction_mode": acq_mode or None,
            "quantity": quantity if quantity else None,
            "value_cr": round(value_cr, 4) if value_cr else None,
            "before_pct": before_pct,
            "after_pct": after_pct,
            "transaction_date": txn_date,
        }
    except Exception as e:
        print(f"[INSIDER] parse error for {symbol}: {e} — row={row}", file=sys.stderr)
        return None


def _parse_date(raw: str) -> str | None:
    """Return ISO date string (YYYY-MM-DD) from various NSE date formats."""
    raw = (raw or "").strip()
    if not raw:
        return None
    # Strip time/sequence suffix (e.g. "13-Feb-2026 16:56" or "13-Feb-2026 1" -> "13-Feb-2026")
    raw = raw.split()[0]
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# DB write
# ---------------------------------------------------------------------------

def upsert_transactions(con, rows: list[dict]) -> int:
    """Insert/replace insider_transactions rows. Returns count upserted."""
    if not rows:
        return 0
    cur = con.cursor()

    if use_postgres():
        sql = """
            INSERT INTO insider_transactions
                (symbol, person_name, person_category, transaction_mode,
                 quantity, value_cr, before_pct, after_pct, transaction_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (symbol, person_name, transaction_date, transaction_mode)
            DO UPDATE SET
                person_category  = EXCLUDED.person_category,
                quantity         = EXCLUDED.quantity,
                value_cr         = EXCLUDED.value_cr,
                before_pct       = EXCLUDED.before_pct,
                after_pct        = EXCLUDED.after_pct,
                fetched_at       = CURRENT_TIMESTAMP
        """
    else:
        sql = """
            INSERT OR REPLACE INTO insider_transactions
                (symbol, person_name, person_category, transaction_mode,
                 quantity, value_cr, before_pct, after_pct, transaction_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """

    data = [
        (
            r["symbol"],
            r["person_name"] or "",
            r["person_category"],
            r["transaction_mode"],
            r["quantity"],
            r["value_cr"],
            r["before_pct"],
            r["after_pct"],
            r["transaction_date"],
        )
        for r in rows
    ]

    cur.executemany(sql, data)
    con.commit()
    return len(data)


# ---------------------------------------------------------------------------
# Feature computation → technical_signals
# ---------------------------------------------------------------------------

def compute_and_write_features(con, symbol: str, days: int = 90) -> None:
    """Aggregate insider_trades for one symbol and write to technical_signals.

    2026-08-07: switched off insider_transactions (this file's own NSE per-symbol pull) onto
    insider_trades. Live-probed NSE's corporates-pit?symbol=X&from=Y&to=Z endpoint directly:
    it does NOT honor its own from/to params (RELIANCE's response mixed dates from 2021 through
    2026 regardless of the requested 90-day window) -- so insider_transactions has had ZERO rows
    dated after 2026-05-02 across all 1,823 symbols ever fetched, for 90+ days, despite the
    fetcher running nightly inside ml-daily-ops and genuinely touching fetched_at every time.
    Every existing health signal looked fine (job success, non-empty upsert, fresh fetched_at) --
    only checking transaction_date (not fetched_at) against a live re-probe of the real endpoint
    exposed it. insider_trades (fed by moneycontrol_fetcher.py + tickertape_deals_fetcher.py
    --insider, already used by insider_features.py for the sibling insider_buy_pct_90d ratio
    feature) is genuinely fresh (~2 days old) and is used here instead. BUY_TYPES/SELL_TYPES
    imported from insider_features.py rather than redefined, so both features can never
    classify the same typeOfTransaction value differently.
    """
    cur = con.cursor()
    # A sliding cutoff, not an exact-match write target -- self-heals regardless of which side
    # of midnight this runs on, unlike the UPDATE below (which needs logical_trading_date()).
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    buy_ph = ','.join(['?'] * len(BUY_TYPES))
    sell_ph = ','.join(['?'] * len(SELL_TYPES))

    if use_postgres():
        cur.execute(
            f"""
            SELECT
                COALESCE(SUM(CASE WHEN UPPER(TRIM("typeOfTransaction")) IN ({buy_ph})
                    THEN "valueInr" ELSE 0 END), 0)  AS buy_inr,
                COALESCE(SUM(CASE WHEN UPPER(TRIM("typeOfTransaction")) IN ({sell_ph})
                    THEN "valueInr" ELSE 0 END), 0)  AS sell_inr
            FROM insider_trades
            WHERE symbol = ?
              AND category ILIKE '%promoter%'
              AND date_iso >= ?
            """,
            (*BUY_TYPES, *SELL_TYPES, symbol, cutoff),
        )
    else:
        cur.execute(
            f"""
            SELECT
                COALESCE(SUM(CASE WHEN UPPER(TRIM("typeOfTransaction")) IN ({buy_ph})
                    THEN "valueInr" ELSE 0 END), 0)  AS buy_inr,
                COALESCE(SUM(CASE WHEN UPPER(TRIM("typeOfTransaction")) IN ({sell_ph})
                    THEN "valueInr" ELSE 0 END), 0)  AS sell_inr
            FROM insider_trades
            WHERE symbol = ?
              AND LOWER(category) LIKE '%promoter%'
              AND date_iso >= ?
            """,
            (*BUY_TYPES, *SELL_TYPES, symbol, cutoff),
        )

    row = cur.fetchone()
    if not row:
        return

    # valueInr is raw INR; the feature (and technical_signals' documented unit) is Cr.
    buy_cr = round(float(row[0] or 0) / 1e7, 4)
    sell_cr = round(float(row[1] or 0) / 1e7, 4)
    net = round(buy_cr - sell_cr, 4)
    insider_buy_flag = 1 if buy_cr > 1.0 else 0
    insider_sell_flag = 1 if sell_cr > 5.0 else 0

    # date = ? guard (2026-07-19): previously matched created_at = MAX(created_at), but
    # technical_signals.created_at is NULL for 100% of rows in production (nothing else in
    # this codebase sets it) -- MAX(created_at) is therefore always NULL, and `created_at =
    # NULL` never matches in SQL, so this UPDATE has never actually written a row, ever.
    # logical_trading_date(), not date.today() (2026-08-01) -- this fetcher runs inside
    # ml-daily-ops, whose step chain regularly finishes after midnight IST; a raw wall-clock
    # date silently targets a day with no grid row yet. See as_of.logical_trading_date's
    # docstring for the incident.
    today = logical_trading_date()
    cur.execute(
        """
        UPDATE technical_signals
        SET
            promoter_buy_90d_cr  = ?,
            promoter_sell_90d_cr = ?,
            promoter_net_90d     = ?,
            insider_buy_flag     = ?,
            insider_sell_flag    = ?
        WHERE symbol = ? AND date = ?
        """,
        (buy_cr, sell_cr, net, insider_buy_flag, insider_sell_flag, symbol, today),
    )

    con.commit()


# ---------------------------------------------------------------------------
# Active stock list
# ---------------------------------------------------------------------------

def get_active_symbols(con, limit: int | None = None) -> list[str]:
    cur = con.cursor()
    sql = "SELECT symbol FROM nse_stocks WHERE status = 'ACTIVE' ORDER BY symbol"
    if limit:
        sql += f" LIMIT {int(limit)}"
    cur.execute(sql)
    return [r[0] for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch NSE insider/promoter transactions")
    parser.add_argument("--symbol", help="Single stock symbol to fetch (test mode)")
    parser.add_argument("--days", type=int, default=90, help="Lookback window in days (default 90)")
    parser.add_argument("--limit", type=int, default=None, help="Process only first N stocks")
    args = parser.parse_args()

    today = date.today()
    to_date = today.strftime(NSE_DATE_FMT)
    from_date = (today - timedelta(days=args.days)).strftime(NSE_DATE_FMT)

    print(
        f"[INSIDER] Fetching insider transactions | from={from_date} to={to_date} | days={args.days}"
    )

    con = connect()
    ensure_schema(con)

    sess = _nse_session()

    if args.symbol:
        symbols = [args.symbol.upper()]
    else:
        symbols = get_active_symbols(con, limit=args.limit)

    print(f"[INSIDER] Processing {len(symbols)} symbol(s)")

    total_rows = 0
    consecutive_fails = 0
    rebuilds = 0
    failed_symbols = 0

    for i, symbol in enumerate(symbols, 1):
        raw = fetch_nse_insider(sess, symbol, from_date, to_date)

        if raw is None:
            failed_symbols += 1
            consecutive_fails += 1
            if consecutive_fails >= CONSECUTIVE_FAIL_LIMIT:
                if rebuilds >= MAX_SESSION_REBUILDS:
                    print(
                        f"[INSIDER] Aborting at {symbol} ({i}/{len(symbols)}): "
                        f"{consecutive_fails} consecutive failures after "
                        f"{rebuilds} session rebuilds — NSE is refusing this run.",
                        file=sys.stderr,
                    )
                    break
                rebuilds += 1
                new_sess = _rebuild_session(rebuilds)
                if new_sess is not None:
                    sess = new_sess
                    consecutive_fails = 0
            continue

        consecutive_fails = 0
        parsed = [p for p in (_parse_record(symbol, r) for r in raw) if p]
        if parsed:
            n = upsert_transactions(con, parsed)
            total_rows += n
            print(f"[INSIDER] {symbol}: {n} transaction(s) stored")
        compute_and_write_features(con, symbol, days=args.days)

        if i % BATCH_SIZE == 0:
            print(f"[INSIDER] Progress: {i}/{len(symbols)} symbols done")

        if i < len(symbols):
            time.sleep(SLEEP_BETWEEN)

    con.close()
    # Report the failure count explicitly: an aggregate-only "N rows upserted" line made a run
    # that died at "E" and skipped 70% of the universe look identical to a healthy one.
    print(
        f"[INSIDER] Done. {total_rows} total rows upserted across {len(symbols)} symbol(s); "
        f"{failed_symbols} symbol(s) failed, {rebuilds} session rebuild(s)."
    )


if __name__ == "__main__":
    main()

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
