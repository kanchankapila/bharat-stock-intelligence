"""
Sector F&O Sentiment Proxy
===========================
Aggregates stock_options_oi by (sector, date) via a JOIN with nse_stocks to
produce a daily sector-level put/call sentiment indicator.

Output table: sector_fo_sentiment(sector, date, sector_pcr, total_call_oi, total_put_oi, symbol_count)

Run: python sector_fo_proxy.py
     python sector_fo_proxy.py --date 2026-06-30
     python sector_fo_proxy.py --backfill
"""

import sys
import os
import argparse
import datetime

sys.path.insert(0, os.path.dirname(__file__))
from db_compat import connect

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS sector_fo_sentiment (
    sector       TEXT        NOT NULL,
    date         DATE        NOT NULL,
    sector_pcr   REAL,
    total_call_oi BIGINT,
    total_put_oi  BIGINT,
    symbol_count  INTEGER,
    PRIMARY KEY (sector, date)
)
"""

_UPSERT = """
INSERT INTO sector_fo_sentiment
    (sector, date, sector_pcr, total_call_oi, total_put_oi, symbol_count)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (sector, date) DO UPDATE SET
    sector_pcr    = EXCLUDED.sector_pcr,
    total_call_oi = EXCLUDED.total_call_oi,
    total_put_oi  = EXCLUDED.total_put_oi,
    symbol_count  = EXCLUDED.symbol_count
"""


def _ensure_table(conn):
    conn.execute(_CREATE_TABLE)
    conn.commit()


def _aggregate_date(conn, date_str: str) -> int:
    rows = conn.execute("""
        SELECT
            ns.sector,
            SUM(soo.total_call_oi)  AS total_call_oi,
            SUM(soo.total_put_oi)   AS total_put_oi,
            COUNT(DISTINCT soo.symbol) AS symbol_count
        FROM stock_options_oi soo
        JOIN nse_stocks ns ON ns.symbol = soo.symbol
        WHERE soo.date::text = ?
          AND ns.sector IS NOT NULL
          AND ns.sector != ''
        GROUP BY ns.sector
    """, (date_str,)).fetchall()

    if not rows:
        return 0

    upsert_rows = []
    for r in rows:
        sector, call_oi, put_oi, sym_count = r[0], int(r[1] or 0), int(r[2] or 0), int(r[3] or 0)
        pcr = round(put_oi / call_oi, 4) if call_oi > 0 else None
        upsert_rows.append((sector, date_str, pcr, call_oi, put_oi, sym_count))

    conn.executemany(_UPSERT, upsert_rows)
    conn.commit()
    return len(upsert_rows)


def run(date_str: str | None = None):
    if date_str is None:
        date_str = datetime.date.today().isoformat()
    conn = connect()
    _ensure_table(conn)
    n = _aggregate_date(conn, date_str)
    conn.close()
    print(f"[Sector FO Proxy] {date_str}: upserted {n} sector rows")


def backfill():
    conn = connect()
    _ensure_table(conn)

    dates = conn.execute("""
        SELECT DISTINCT date::text FROM stock_options_oi ORDER BY date
    """).fetchall()

    if not dates:
        print("[Sector FO Proxy] No data in stock_options_oi.")
        conn.close()
        return

    total = 0
    for (d,) in dates:
        date_str = str(d)[:10]
        n = _aggregate_date(conn, date_str)
        print(f"  {date_str}: {n} sectors")
        total += n

    conn.close()
    print(f"[Sector FO Proxy] Backfill done - {total} rows across {len(dates)} dates.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default=None, help='YYYY-MM-DD (default: today)')
    parser.add_argument('--backfill', action='store_true', help='Aggregate all stock_options_oi dates')
    args = parser.parse_args()

    if args.backfill:
        backfill()
    else:
        run(args.date)
