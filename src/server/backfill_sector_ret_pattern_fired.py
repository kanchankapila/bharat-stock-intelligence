#!/usr/bin/env python3
"""
One-off historical backfill for AF-20260829-39: sector_ret_5d/21d have been 100% NULL for
every pattern-fired technical_signals row (signal_type != 'GRID') since both columns existed --
technical_analysis_engine.py never writes them, and backfill_technical_features.py's repair pass
was GRID-only until this session's fix. That fix only covers the *latest* date going forward;
this script backfills every historical pattern-fired row still missing the value.

Reuses the exact same equal-weight per-sector mean computation as
_load_flow_sector_inputs()/technicalSignalsService.getSectorMomentum(), just without that
function's 75-day window (which is correctly sized for the daily "today" job, not a multi-year
historical repair).

Run:
  python backfill_sector_ret_pattern_fired.py            # all missing rows
  python backfill_sector_ret_pattern_fired.py --dry-run   # count only, no writes
"""
import argparse
from db_compat import connect


def backfill(dry_run: bool = False) -> int:
    con = connect()
    cur = con.cursor()

    cur.execute("""
        SELECT count(*) AS c FROM technical_signals
        WHERE signals_json IS NOT NULL AND sector_ret_5d IS NULL
    """)
    missing_before = cur.fetchone()['c']
    print(f"[SectorBackfill] {missing_before} pattern-fired rows missing sector_ret_5d.")
    if missing_before == 0:
        return 0
    if dry_run:
        print("[SectorBackfill] --dry-run: not writing.")
        return missing_before

    # Same LAG-based per-sector mean as _load_flow_sector_inputs, over full history instead of
    # a 75-day window. One-shot: computed once, applied to every missing row via a single
    # UPDATE ... FROM, rather than a per-row Python loop (13k+ rows).
    cur.execute("""
        WITH daily_close AS (
            SELECT o.symbol, o.date::text AS d, n.sector,
                   LAG(o.close, 5)  OVER (PARTITION BY o.symbol ORDER BY o.date) AS prev5,
                   LAG(o.close, 21) OVER (PARTITION BY o.symbol ORDER BY o.date) AS prev21,
                   o.close AS c
            FROM stock_ohlcv o
            JOIN nse_stocks n ON n.symbol = o.symbol AND n.sector IS NOT NULL
            WHERE COALESCE(o.is_suspect,0) = 0
        ),
        sector_mom AS (
            SELECT d, sector,
                   AVG(100.0 * (c / NULLIF(prev5, 0)  - 1)) AS r5,
                   AVG(100.0 * (c / NULLIF(prev21, 0) - 1)) AS r21
            FROM daily_close
            GROUP BY d, sector
        )
        UPDATE technical_signals ts
        SET sector_ret_5d = sm.r5, sector_ret_21d = sm.r21
        FROM sector_mom sm, nse_stocks n
        WHERE n.symbol = ts.symbol
          AND n.sector = sm.sector
          AND sm.d = ts.date::text
          AND ts.signals_json IS NOT NULL
          AND ts.sector_ret_5d IS NULL
          AND (sm.r5 IS NOT NULL OR sm.r21 IS NOT NULL)
    """)
    updated = cur.rowcount
    con.commit()

    cur.execute("""
        SELECT count(*) AS c FROM technical_signals
        WHERE signals_json IS NOT NULL AND sector_ret_5d IS NULL
    """)
    missing_after = cur.fetchone()['c']
    print(f"[SectorBackfill] updated {updated} rows. "
          f"{missing_before} -> {missing_after} still missing "
          f"(remainder has no sector-momentum data available, e.g. warm-up days or unmapped sector).")
    return updated


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    backfill(dry_run=args.dry_run)
