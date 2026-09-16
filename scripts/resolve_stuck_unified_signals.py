"""
Resolve unified_signals rows that could never leave ACTIVE.

WHY THIS EXISTS SEPARATELY FROM THE CODE FIX
--------------------------------------------
signals.ts's updateSignalAccuracy matched signal_type against the literal strings 'BUY' and
'SELL'. unified_signals has never had one signal_type vocabulary -- technical_analysis_engine.py
writes 'Bullish'/'Bearish'/'Neutral', screener_signal_generator.py writes 'SCREENER_ENTRY' and
'SECTOR_SCREENER_CONFLUENCE' -- so every other spelling fell through with status untouched.
Measured live 2026-08-16: signal_source 'technical' was 24,442 rows / 100% ACTIVE with 0
COMPLETED and 0 FAILED, SCREENER_SURFACING another 1,243.

That was fixed in signals.ts (commit 1d9c3c4) by deriving direction from geometry. But
".claude/rules/recurring-bugs.md": *fixing NaN at the source does not clean rows the bug
already wrote* -- the same applies here. updateSignalAccuracy only ever sees the CURRENT price,
so even after the fix it cannot correctly resolve a signal from June whose target was hit in
July and whose price has since fallen back. Those 25,685 rows need a path-based backfill.

METHOD
------
For each stuck row, direction comes from the row's OWN GEOMETRY (target above stop = long),
exactly as resolveSignalOutcome does -- not from a signal_type list, which is the defect being
repaired. Then the first TOUCH is found in stock_ohlcv over (signal_date, today]:

  long :  high >= target -> COMPLETED      low  <= stop -> FAILED
  short:  low  <= target -> COMPLETED      high >= stop -> FAILED

Whichever comes first by date wins. If BOTH are touched on the same bar the row is resolved
FAILED: a daily bar does not record intra-day ordering, and booking the loss is the
conservative reading -- assuming the target printed first would inflate every measured win rate
computed off this column. Rows where neither level is touched stay ACTIVE, correctly.

is_suspect bars are excluded (panel spec, .claude/rules/measurement.md): ~425 quarantined bars
exist and a single bad print would otherwise resolve a signal on a price that never traded.

Rows with a NULL target_price or stop_loss are left alone -- SECTOR_SCREENER_CONFLUENCE carries
neither, and there is no direction to read.

USAGE
  python scripts/resolve_stuck_unified_signals.py              # dry run, prints the plan
  python scripts/resolve_stuck_unified_signals.py --apply      # writes
"""

import argparse
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "server"))
from db_compat import connect  # noqa: E402

# One statement. The lateral finds the earliest bar touching either level, and reports which.
PLAN_SQL = """
WITH stuck AS (
    SELECT id, symbol, signal_source, signal_type, signal_date,
           target_price AS target, stop_loss AS stop,
           (target_price > stop_loss) AS is_long
    FROM unified_signals
    WHERE status = 'ACTIVE'
      AND target_price IS NOT NULL
      AND stop_loss IS NOT NULL
      AND target_price <> stop_loss
),
touch AS (
    SELECT s.id, s.symbol, s.signal_source, s.is_long, t.date AS touch_date,
           t.hit_target, t.hit_stop
    FROM stuck s
    CROSS JOIN LATERAL (
        SELECT o.date,
               (CASE WHEN s.is_long THEN o.high >= s.target ELSE o.low  <= s.target END) AS hit_target,
               (CASE WHEN s.is_long THEN o.low  <= s.stop   ELSE o.high >= s.stop   END) AS hit_stop
        FROM stock_ohlcv o
        WHERE o.symbol = s.symbol
          AND o.date > s.signal_date::date
          AND COALESCE(o.is_suspect, 0) = 0
          AND o.high IS NOT NULL AND o.low IS NOT NULL
          AND ((CASE WHEN s.is_long THEN o.high >= s.target ELSE o.low  <= s.target END)
            OR (CASE WHEN s.is_long THEN o.low  <= s.stop   ELSE o.high >= s.stop   END))
        ORDER BY o.date
        LIMIT 1
    ) t
)
SELECT id, symbol, signal_source,
       -- Same-bar ambiguity resolves to FAILED; see the module docstring.
       CASE WHEN hit_stop THEN 'FAILED' ELSE 'COMPLETED' END AS new_status
FROM touch
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the resolved statuses")
    ap.add_argument(
        "--sources",
        default="technical,SCREENER_SURFACING",
        help=(
            "comma-separated signal_source values to write (default: the two that could NEVER "
            "resolve). Pass 'all' to include AI/screener/technical_scan -- see the note below "
            "before doing that."
        ),
    )
    args = ap.parse_args()

    # Why the default is NOT 'all', even though the method is sound for every source:
    # AI, screener and technical_scan were never broken by the signal_type bug -- they resolve
    # through updateSignalAccuracy normally. They nonetheless carry a large unresolved backlog
    # (measured 2026-08-16: 26,959 rows this query can resolve) because that function only ever
    # compares the CURRENT price, so any target or stop touched BETWEEN two runs is missed
    # permanently. That is a real, separate defect with its own blast radius -- it changes the
    # status of rows nobody reported as broken -- so it is opt-in rather than bundled in here.

    conn = connect()

    total_active = conn.execute(
        "SELECT COUNT(*) FROM unified_signals WHERE status = 'ACTIVE'"
    ).fetchone()[0]
    no_levels = conn.execute(
        "SELECT COUNT(*) FROM unified_signals WHERE status = 'ACTIVE' "
        "AND (target_price IS NULL OR stop_loss IS NULL OR target_price = stop_loss)"
    ).fetchone()[0]

    rows = conn.execute(PLAN_SQL).fetchall()
    by_source = Counter((r[2], r[3]) for r in rows)

    print(f"ACTIVE rows total            : {total_active}")
    print(f"  no usable levels (skipped) : {no_levels}")
    print(f"  resolvable from OHLCV      : {len(rows)}")
    print(f"  still open (never touched) : {total_active - no_levels - len(rows)}")
    print()
    print(f"{'signal_source':22} {'new_status':12} {'rows':>8}")
    print("-" * 44)
    for (src, status), n in sorted(by_source.items()):
        print(f"{src:22} {status:12} {n:>8}")

    wanted = None if args.sources.strip().lower() == "all" else {
        s.strip() for s in args.sources.split(",") if s.strip()
    }
    targeted = [r for r in rows if wanted is None or r[2] in wanted]
    print(f"\nsources selected for write : {args.sources}  ->  {len(targeted)} rows")

    if not args.apply:
        print("DRY RUN -- nothing written. Re-run with --apply.")
        conn.close()
        return

    updated = 0
    for rid, _sym, _src, new_status in targeted:
        conn.execute(
            "UPDATE unified_signals SET status = ? WHERE id = ? AND status = 'ACTIVE'",
            (new_status, rid),
        )
        updated += 1
    conn.commit()
    print(f"\nAPPLIED: {updated} rows updated.")
    conn.close()


if __name__ == "__main__":
    main()
