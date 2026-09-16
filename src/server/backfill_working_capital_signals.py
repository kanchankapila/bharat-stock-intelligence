#!/usr/bin/env python3
"""
Backfill Working Capital & CCC Signals into technical_signals
============================================================
Populates receivables_days_ttm, ccc_ttm, ccc_trend, wc_deteriorating,
and wc_improving on technical_signals using working_capital_history.
Resolves ACTION_ITEMS #23 (ccc_trend).

FIXED 2026-09-01 (data/model audit): the original version did
`UPDATE technical_signals SET ... WHERE symbol = %s` with no date filter,
smearing the LATEST fiscal year's values across a symbol's entire
technical_signals history -- confirmed live: RELIANCE carried the identical
ccc_ttm=-21.65/ccc_trend=-6.96 on every date from 2026-05-25 through
2026-08-31, look-ahead leakage into anything training on those columns
(the exact class financial_ratios_fetcher.py's as_of_floor() exists to
prevent). Rewritten as a point-in-time as-of join: a technical_signals row
only ever sees the working-capital fiscal year that was actually knowable
as of that row's own date (fiscal_year_end + PUBLICATION_LAG_DAYS), matching
et_stats_client.py's as_of_floor() convention. Rows before any fiscal year
was knowable are left untouched (NULL), not backfilled with a later value.

Run:
  python backfill_working_capital_signals.py             # fix + backfill
  python backfill_working_capital_signals.py --dry-run    # report only
"""

import argparse
import os
import time

import psycopg2
from dotenv import load_dotenv

load_dotenv()

# Same convention as et_stats_client.py's as_of_floor(): statutory filing deadline + margin.
PUBLICATION_LAG_DAYS = 90
DETERIORATING_THRESHOLD = 5.0
IMPROVING_THRESHOLD = -5.0

_AS_OF_UPDATE_SQL = f"""
    WITH wc_with_trend AS (
        SELECT symbol, fiscal_year::date AS fy_end,
               (fiscal_year::date + INTERVAL '{PUBLICATION_LAG_DAYS} days')::date AS knowable_at,
               receivables_days, ccc,
               LAG(ccc) OVER (PARTITION BY symbol ORDER BY fiscal_year::date) AS prev_ccc
        FROM working_capital_history
    )
    UPDATE technical_signals ts
    SET (receivables_days_ttm, ccc_ttm, ccc_trend, wc_deteriorating, wc_improving) = (
        SELECT
            w.receivables_days,
            w.ccc,
            CASE WHEN w.prev_ccc IS NOT NULL
                 THEN round((w.ccc - w.prev_ccc)::numeric, 2) ELSE NULL END,
            CASE WHEN w.prev_ccc IS NOT NULL AND (w.ccc - w.prev_ccc) >= {DETERIORATING_THRESHOLD}
                 THEN 1 ELSE 0 END,
            CASE WHEN w.prev_ccc IS NOT NULL AND (w.ccc - w.prev_ccc) <= {IMPROVING_THRESHOLD}
                 THEN 1 ELSE 0 END
        FROM wc_with_trend w
        WHERE w.symbol = ts.symbol AND w.knowable_at <= ts.date::date
        ORDER BY w.fy_end DESC
        LIMIT 1
    )
    WHERE EXISTS (
        SELECT 1 FROM wc_with_trend w
        WHERE w.symbol = ts.symbol AND w.knowable_at <= ts.date::date
    )
"""


def backfill_working_capital_signals(dry_run: bool = False) -> int:
    t0 = time.time()
    conn = psycopg2.connect(os.environ.get("POSTGRES_URL"))
    cur = conn.cursor()

    print("[WC-Backfill] Clearing previously-corrupted columns "
          "(the old symbol-only UPDATE smeared the latest fiscal year across all history)...")
    if not dry_run:
        cur.execute("""
            UPDATE technical_signals
            SET receivables_days_ttm = NULL, ccc_ttm = NULL, ccc_trend = NULL,
                wc_deteriorating = 0, wc_improving = 0
            WHERE ccc_ttm IS NOT NULL OR receivables_days_ttm IS NOT NULL
        """)
        cleared = cur.rowcount
        conn.commit()
        print(f"[WC-Backfill] Cleared {cleared:,} rows.")
    else:
        cur.execute("SELECT count(*) FROM technical_signals WHERE ccc_ttm IS NOT NULL")
        print(f"[WC-Backfill] --dry-run: would clear {cur.fetchone()[0]:,} rows.")

    print("[WC-Backfill] Applying point-in-time as-of backfill "
          f"(knowable_at = fiscal_year_end + {PUBLICATION_LAG_DAYS}d)...")
    if dry_run:
        # Count-only variant: same WHERE EXISTS, no write.
        cur.execute(f"""
            WITH wc_with_trend AS (
                SELECT symbol, fiscal_year::date AS fy_end,
                       (fiscal_year::date + INTERVAL '{PUBLICATION_LAG_DAYS} days')::date AS knowable_at
                FROM working_capital_history
            )
            SELECT count(*) FROM technical_signals ts
            WHERE EXISTS (
                SELECT 1 FROM wc_with_trend w
                WHERE w.symbol = ts.symbol AND w.knowable_at <= ts.date::date
            )
        """)
        print(f"[WC-Backfill] --dry-run: would update {cur.fetchone()[0]:,} rows. Not writing.")
        cur.close()
        conn.close()
        return 0

    cur.execute(_AS_OF_UPDATE_SQL)
    updated = cur.rowcount
    conn.commit()

    cur.execute("""
        SELECT count(*) FILTER (WHERE ccc_ttm IS NOT NULL) as ccc_cnt,
               count(*) FILTER (WHERE ccc_trend IS NOT NULL) as ccc_trend_cnt,
               count(*) FILTER (WHERE wc_improving = 1) as wc_imp_cnt,
               count(*) FILTER (WHERE wc_deteriorating = 1) as wc_det_cnt,
               count(*) as total_rows
        FROM technical_signals
        WHERE date >= CURRENT_DATE - INTERVAL '5 days';
    """)
    stats = cur.fetchone()
    print(f"\n[WC-Backfill] Updated {updated:,} rows in {time.time()-t0:.2f}s.")
    print("[WC-Backfill] Recent technical_signals coverage:")
    print(f"  ccc_ttm populated: {stats[0]:,}")
    print(f"  ccc_trend populated (2+ fiscal years knowable): {stats[1]:,}")
    print(f"  wc_improving flagged: {stats[2]:,}")
    print(f"  wc_deteriorating flagged: {stats[3]:,}")
    print(f"  Total recent rows: {stats[4]:,}")

    cur.close()
    conn.close()
    return updated


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    backfill_working_capital_signals(dry_run=args.dry_run)
