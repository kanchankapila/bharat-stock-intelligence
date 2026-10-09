"""AF-20261008-13(b): eps_surprise_history rows booked on ambiguous MoneyControl codes.

eps_surprise_fetcher built `{mcsymbol: symbol}` with a dict comprehension until AF-20260918-02,
so a code shared by several NSE names (KMF -> KOTAK/KOTAKBANK/MAHINDRA) was booked against
whichever name came last. Rows are keyed (scid, quarter); there is no company-name column, so an
ambiguous code's true owner cannot be recovered -- those rows are DELETED. Rows on an unambiguous
code whose stored symbol disagrees with mc_symbol_map's MC_TO_SYMBOL_SQL are REATTRIBUTED.

    python scripts/repair/repair_eps_surprise_mcsymbol.py                 # dry-run
    python scripts/repair/repair_eps_surprise_mcsymbol.py --apply --dump-path eps.dump
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import Op, parser, run  # noqa: E402
from mc_symbol_map import MC_TO_SYMBOL_SQL  # noqa: E402

# Complement of MC_TO_SYMBOL_SQL: the codes it drops.
AMBIGUOUS_SQL = """(
    SELECT TRIM(mcsymbol) FROM nse_stocks
    WHERE TRIM(mcsymbol) <> '' AND TRIM(symbol) <> ''
    GROUP BY TRIM(mcsymbol)
    HAVING COUNT(DISTINCT TRIM(symbol)) > 1
)"""

T = "eps_surprise_history"


def main(argv=None, conn=None) -> int:
    args = parser(__doc__).parse_args(argv)

    def plan(conn):
        amb = f"TRIM(scid) IN {AMBIGUOUS_SQL}"
        wrong = f"FROM {T} e JOIN {MC_TO_SYMBOL_SQL} m ON m.mcsymbol = TRIM(e.scid) WHERE e.symbol IS DISTINCT FROM m.symbol"
        return [
            Op(T, "delete", f"SELECT count(*) FROM {T} WHERE {amb}", f"DELETE FROM {T} WHERE {amb}"),
            Op(T, "reattribute", f"SELECT count(*) {wrong}",
               f"UPDATE {T} e SET symbol = m.symbol FROM {MC_TO_SYMBOL_SQL} m "
               f"WHERE m.mcsymbol = TRIM(e.scid) AND e.symbol IS DISTINCT FROM m.symbol"),
        ], []
    return run(args, conn, plan)


if __name__ == "__main__":
    raise SystemExit(main())
