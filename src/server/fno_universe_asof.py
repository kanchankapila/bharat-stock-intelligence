"""Point-in-time F&O eligibility for the deep-panel F&O tier.

`nse_stocks.fno_eligible` is a current-state flag; applied to 2021-2026 history it injects
survivorship into the one tier whose verdict matters. Membership here is derived from the
dated old-format F&O bhavcopy rows in `stock_option_features_history` (source `nse_fo_bhav_old`):
a symbol with a stock-option row on a date was F&O-eligible on that date. Reads only.

The series is bounded -- see `fno_series_coverage`. A date outside it returns an empty set,
never today's flag.
"""

_STOCK_OPTIONS = "instrument = 'OPTSTK'"


def fno_eligible_asof(conn, date: str) -> set[str]:
    rows = conn.execute(
        "SELECT DISTINCT symbol FROM stock_option_features_history "
        f"WHERE {_STOCK_OPTIONS} AND trade_date = CAST(? AS DATE)",
        (date,),
    ).fetchall()
    return {r[0] for r in rows}


def fno_series_coverage(conn) -> tuple[str, str]:
    """First and last date a dated series exists. The caller bounds the F&O tier's verdict to it."""
    first, last = conn.execute(
        "SELECT MIN(trade_date), MAX(trade_date) FROM stock_option_features_history "
        f"WHERE {_STOCK_OPTIONS}"
    ).fetchone()
    if first is None:
        raise ValueError("no dated F&O series: stock_option_features_history has no OPTSTK rows")
    return str(first), str(last)
