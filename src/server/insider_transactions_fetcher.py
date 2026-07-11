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
import sys
import argparse
import time
from datetime import datetime, timedelta, date

import requests

from db_compat import connect, translate, use_postgres

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

SLEEP_BETWEEN = 0.3  # seconds between per-symbol requests


# ---------------------------------------------------------------------------
# NSE session (same pattern as asm_gsm_fetcher.py)
# ---------------------------------------------------------------------------

def _nse_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.get("https://www.nseindia.com/", timeout=10)
    return s


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
        "ALTER TABLE technical_signals ADD COLUMN promoter_buy_90d_cr  REAL",
        "ALTER TABLE technical_signals ADD COLUMN promoter_sell_90d_cr REAL",
        "ALTER TABLE technical_signals ADD COLUMN promoter_net_90d     REAL",
        "ALTER TABLE technical_signals ADD COLUMN insider_buy_flag     INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN insider_sell_flag    INTEGER DEFAULT 0",
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
) -> list[dict]:
    """Fetch insider trading records for one symbol from NSE.

    Returns a list of raw dicts from the NSE API `data` array.
    """
    url = NSE_INSIDER_URL.format(
        symbol=symbol,
        from_date=from_date,
        to_date=to_date,
    )
    try:
        r = sess.get(url, timeout=12)
        if r.status_code == 200:
            payload = r.json()
            return payload.get("data") or []
        print(f"[INSIDER] {symbol}: HTTP {r.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"[INSIDER] {symbol}: fetch error — {e}", file=sys.stderr)
    return []


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

        # Before / after shareholding %
        total_shares = row.get("totSharesNo") or row.get("totalShares") or 0
        bef_shares = row.get("befAcqSharesNo") or row.get("beforeShares") or 0
        aft_shares = row.get("afterAcqSharesNo") or row.get("afterShares") or 0

        def _pct(n):
            try:
                n, t = float(n), float(total_shares)
                return round(n / t * 100, 4) if t else None
            except (TypeError, ValueError):
                return None

        before_pct = _pct(bef_shares)
        after_pct = _pct(aft_shares)

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
    """Aggregate insider_transactions for one symbol and write to technical_signals."""
    cur = con.cursor()
    # transaction_date is TEXT ('YYYY-MM-DD'); compare as an ISO string so Postgres doesn't
    # choke on text >= date ("no operator matches"). ISO dates sort lexicographically.
    cutoff = (date.today() - timedelta(days=days)).isoformat()

    if use_postgres():
        cur.execute(
            """
            SELECT
                COALESCE(SUM(CASE
                    WHEN LOWER(transaction_mode) LIKE '%purchase%'
                      OR LOWER(transaction_mode) LIKE '%buy%'
                     THEN value_cr ELSE 0 END), 0)  AS buy_cr,
                COALESCE(SUM(CASE
                    WHEN LOWER(transaction_mode) LIKE '%sale%'
                      OR LOWER(transaction_mode) LIKE '%sell%'
                     THEN value_cr ELSE 0 END), 0)  AS sell_cr
            FROM insider_transactions
            WHERE symbol = ?
              AND person_category ILIKE '%promoter%'
              AND transaction_date >= ?
            """,
            (symbol, cutoff),
        )
    else:
        cur.execute(
            """
            SELECT
                COALESCE(SUM(CASE
                    WHEN LOWER(transaction_mode) LIKE '%purchase%'
                      OR LOWER(transaction_mode) LIKE '%buy%'
                     THEN value_cr ELSE 0 END), 0)  AS buy_cr,
                COALESCE(SUM(CASE
                    WHEN LOWER(transaction_mode) LIKE '%sale%'
                      OR LOWER(transaction_mode) LIKE '%sell%'
                     THEN value_cr ELSE 0 END), 0)  AS sell_cr
            FROM insider_transactions
            WHERE symbol = ?
              AND LOWER(person_category) LIKE '%promoter%'
              AND transaction_date >= ?
            """,
            (symbol, cutoff),
        )

    row = cur.fetchone()
    if not row:
        return

    buy_cr, sell_cr = float(row[0]), float(row[1])
    net = round(buy_cr - sell_cr, 4)
    insider_buy_flag = 1 if buy_cr > 1.0 else 0
    insider_sell_flag = 1 if sell_cr > 5.0 else 0

    # Update the most-recent technical_signals row for this symbol (COALESCE pattern)
    if use_postgres():
        cur.execute(
            """
            UPDATE technical_signals
            SET
                promoter_buy_90d_cr  = ?,
                promoter_sell_90d_cr = ?,
                promoter_net_90d     = ?,
                insider_buy_flag     = ?,
                insider_sell_flag    = ?
            WHERE symbol = ?
              AND created_at = (
                  SELECT MAX(created_at) FROM technical_signals WHERE symbol = ?
              )
            """,
            (buy_cr, sell_cr, net, insider_buy_flag, insider_sell_flag, symbol, symbol),
        )
    else:
        cur.execute(
            """
            UPDATE technical_signals
            SET
                promoter_buy_90d_cr  = ?,
                promoter_sell_90d_cr = ?,
                promoter_net_90d     = ?,
                insider_buy_flag     = ?,
                insider_sell_flag    = ?
            WHERE symbol = ?
              AND created_at = (
                  SELECT MAX(created_at) FROM technical_signals WHERE symbol = ?
              )
            """,
            (buy_cr, sell_cr, net, insider_buy_flag, insider_sell_flag, symbol, symbol),
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
    for i, symbol in enumerate(symbols, 1):
        raw = fetch_nse_insider(sess, symbol, from_date, to_date)
        parsed = [p for p in (_parse_record(symbol, r) for r in raw) if p]
        if parsed:
            n = upsert_transactions(con, parsed)
            total_rows += n
            print(f"[INSIDER] {symbol}: {n} transaction(s) stored")
        compute_and_write_features(con, symbol, days=args.days)

        if i % 50 == 0:
            print(f"[INSIDER] Progress: {i}/{len(symbols)} symbols done")

        if i < len(symbols):
            time.sleep(SLEEP_BETWEEN)

    con.close()
    print(
        f"[INSIDER] Done. {total_rows} total rows upserted across {len(symbols)} symbol(s)."
    )


if __name__ == "__main__":
    main()
