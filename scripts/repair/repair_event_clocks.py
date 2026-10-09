"""AF-20261008-13(a): recompute past technical_signals.days_to_next_results and
earnings_shocker_flag/_gain POINT-IN-TIME.

densify_feature_matrix.py forward-filled both for up to 120 sessions (AF-20261008-12, fixed
482856df). For each past date D in [--since, --until] this rewrites the stored value with what
was knowable on D, and sets NULL where nothing was.

Point-in-time rule: a source row counts for D only if its `fetched_at` is on or before D
(`fetched_at < D + 1 day`, session time zone). Countdown = MIN(result_date >= D) - D per symbol,
with the writer's reschedule rule (only dates within 1h of the scid's newest fetch as of D).
Shocker flag = 1 with that day's gain if the stock was in a mc_price_shockers fetch made ON D,
else NULL.

WHAT CANNOT BE RECONSTRUCTED -- read before approving --apply:
  * Both source tables are upserted, so `fetched_at` is the LAST time a row was seen, not the
    first. A result date that was already announced on D but re-seen after D carries a later
    fetched_at and is excluded: the countdown for most past dates becomes NULL, and values
    survive mainly where the result date itself was within a day or two of D. NULL is the
    honest value (unknown), not a fabricated countdown, but it is sparse.
  * The same for shockers: a stock on the list on D and again later only shows its last day.
    Past 0s are not reconstructible (absence of a row is not proof of absence from the list),
    so they become NULL, not 0.
  * A reschedule visible only after D cannot be undone for D (the old row's fetched_at moved).
  Writes from the fixed writer start 2026-10-08; --until defaults to the day before.

    python scripts/repair/repair_event_clocks.py                          # dry-run
    python scripts/repair/repair_event_clocks.py --apply --dump-path technical_signals.dump
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from mc_symbol_map import MC_TO_SYMBOL_SQL  # noqa: E402

SINCE = "2026-06-30"   # stock_earnings_dates coverage starts here
UNTIL = "2026-10-07"   # last date before the densify fix landed

PIT_DAYS = f"""WITH k AS MATERIALIZED (
    SELECT TRIM(scid) AS scid, result_date, fetched_at::timestamptz AS seen,
           MAX(fetched_at::timestamptz) OVER (PARTITION BY TRIM(scid)) AS last_seen
    FROM stock_earnings_dates
    WHERE result_date >= CAST(? AS date) AND fetched_at::timestamptz < CAST(? AS date) + 1
), pit AS MATERIALIZED (
    SELECT ns.symbol, MIN(k.result_date) - CAST(? AS date) AS days
    FROM k JOIN {MC_TO_SYMBOL_SQL} ns ON ns.mcsymbol = k.scid
    WHERE k.seen >= k.last_seen - INTERVAL '1 hour'
    GROUP BY ns.symbol
)"""
DAYS = "(SELECT p.days FROM pit p WHERE p.symbol = ts.symbol)"
DAYS_WHERE = f"ts.date = CAST(? AS date) AND ts.days_to_next_results IS DISTINCT FROM {DAYS}"

PIT_SHOCK = f"""WITH s AS MATERIALIZED (
    SELECT ns.symbol, MAX(sh.gain_since_result) AS gain
    FROM mc_price_shockers sh JOIN {MC_TO_SYMBOL_SQL} ns ON ns.mcsymbol = TRIM(sh.scid)
    WHERE sh.fetched_at::timestamptz >= CAST(? AS date)
      AND sh.fetched_at::timestamptz < CAST(? AS date) + 1
    GROUP BY ns.symbol
)"""
FLAG = "(SELECT 1 FROM s WHERE s.symbol = ts.symbol)"
GAIN = "(SELECT s.gain FROM s WHERE s.symbol = ts.symbol)"
SHOCK_WHERE = (f"ts.date = CAST(? AS date) AND (ts.earnings_shocker_flag IS DISTINCT FROM {FLAG} "
               f"OR ts.earnings_shocker_gain IS DISTINCT FROM {GAIN})")


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--since", default=SINCE)
    ap.add_argument("--until", default=UNTIL)
    args = ap.parse_args(argv)

    def plan(conn):
        dates = [str(r[0]) for r in conn.execute(
            "SELECT DISTINCT date FROM technical_signals "
            "WHERE date >= CAST(? AS date) AND date <= CAST(? AS date) ORDER BY 1",
            (args.since, args.until)).fetchall()]
        ops = []
        for d in dates:
            ops.append(Op("days_to_next_results", "change",
                          f"{PIT_DAYS} SELECT count(*) FROM technical_signals ts WHERE {DAYS_WHERE}",
                          f"{PIT_DAYS} UPDATE technical_signals ts SET days_to_next_results = {DAYS} "
                          f"WHERE {DAYS_WHERE}",
                          (d, d, d, d)))
            ops.append(Op("earnings_shocker", "change",
                          f"{PIT_SHOCK} SELECT count(*) FROM technical_signals ts WHERE {SHOCK_WHERE}",
                          f"{PIT_SHOCK} UPDATE technical_signals ts SET earnings_shocker_flag = {FLAG}, "
                          f"earnings_shocker_gain = {GAIN} WHERE {SHOCK_WHERE}",
                          (d, d, d)))
        return ops, [f"technical_signals: {len(dates)} dates in {args.since}..{args.until}"]
    return run(args, conn, plan)


if __name__ == "__main__":
    raise SystemExit(main())
