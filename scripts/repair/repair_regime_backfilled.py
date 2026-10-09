"""AF-20261008-13(f): mark market_regimes rows from the one in-sample backfill.

Rows dated before 2026-08-10 were labelled by a model fitted 2026-08-09 over that same history,
so by-regime measurements must be able to exclude them. This only SETS a flag, and only if a
`backfilled` column already exists -- adding the column is a migration (a separate, approved
change), never done here. Without the column the script reports "absent" and writes nothing.

    python scripts/repair/repair_regime_backfilled.py                 # dry-run
    python scripts/repair/repair_regime_backfilled.py --apply --dump-path market_regimes.dump
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, column_exists, parser, run  # noqa: E402

IN_SAMPLE_BEFORE = "2026-08-10"


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--before", default=IN_SAMPLE_BEFORE)
    args = ap.parse_args(argv)

    def plan(conn):
        if not column_exists(conn, "market_regimes", "backfilled"):
            return [], ["market_regimes.backfilled: absent (needs a migration first), nothing to do"]
        where = "date::text < ? AND backfilled IS DISTINCT FROM TRUE"
        return [Op("market_regimes", "update",
                   f"SELECT count(*) FROM market_regimes WHERE {where}",
                   f"UPDATE market_regimes SET backfilled = TRUE WHERE {where}",
                   (args.before,))], []
    return run(args, conn, plan)


if __name__ == "__main__":
    raise SystemExit(main())
