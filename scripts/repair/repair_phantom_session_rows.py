"""AF-20261008-13(c): delete rows stamped on days NSE did not trade.

Before the 2026-10-08 is_trading_session() guards, the F&O / breadth writers stamped Saturdays,
Sundays and holidays with copies of the previous session (10-02 and 10-04 are 100% copies of
10-01). A phantom day = ISO weekday 6/7 or a `market_holidays` NSE date -- the same calendar the
writers' guard uses (as_of.is_trading_session), so a Muhurat session on a listed holiday is
treated as closed here too. Tables found by reading the guarded writers and counting
closed-day rows in production (2026-10-09, read-only).

    python scripts/repair/repair_phantom_session_rows.py                 # dry-run
    python scripts/repair/repair_phantom_session_rows.py --apply --dump-path tables.dump
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run, table_exists  # noqa: E402

TABLES = (
    "stock_futures_oi_history",   # mc_stock_futures_oi_fetcher
    "ndtv_fno_basis",             # ndtv_fno_basis_fetcher
    "nt_fno_dashboard",           # nt_dashboard_fetcher
    "so_option_chain",            # so_option_chain_fetcher
    "so_stock_oi_summary",        # so_option_chain_fetcher
    "mc_advance_decline",         # mc_advance_decline_fetcher
    "market_breadth",             # mc_advance_decline_fetcher
)

CLOSED = ("(EXTRACT(ISODOW FROM date) IN (6, 7) "
          "OR date IN (SELECT date FROM market_holidays WHERE exchange = 'NSE'))")


def main(argv=None, conn=None) -> int:
    ap = parser(__doc__)
    ap.add_argument("--tables", nargs="+", choices=TABLES, default=list(TABLES))
    args = ap.parse_args(argv)

    def plan(conn):
        ops, notes = [], []
        for t in args.tables:
            if not table_exists(conn, t):
                notes.append(f"{t}: absent, skipped")
                continue
            ops.append(Op(t, "delete", f"SELECT count(*) FROM {t} WHERE {CLOSED}",
                          f"DELETE FROM {t} WHERE {CLOSED}"))
        return ops, notes
    return run(args, conn, plan)


if __name__ == "__main__":
    raise SystemExit(main())
