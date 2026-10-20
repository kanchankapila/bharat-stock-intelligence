"""Point-in-time F&O eligibility for the deep-panel F&O tier.

`nse_stocks.fno_eligible` is a current-state flag; applied to 2021-2026 history it injects
survivorship into the one tier whose verdict matters. Membership here is derived from the
dated old-format F&O bhavcopy rows in `stock_option_features_history` (source `nse_fo_bhav_old`):
a symbol with a stock-option row on a date was F&O-eligible on that date. Reads only.

The series is bounded and has holes -- see `fno_series_coverage` and `is_covered`. A date
outside it returns an empty set, never today's flag.

Asymmetry: option-row presence slightly LAGS F&O exits (existing contracts keep trading after
an exclusion), while entry is exact.
"""

_STOCK_OPTIONS = "instrument = 'OPTSTK'"


def fno_eligible_asof(conn, date: str) -> set[str]:
    """Symbols F&O-eligible on exactly `date`.

    An empty set is AMBIGUOUS: "no data for this date" or "no members". Gate on
    `is_covered` before using the complement (`universe - eligible`), which is fail-open
    on an uncovered date: every F&O name would land in a non-F&O tier.
    """
    rows = conn.execute(
        "SELECT DISTINCT symbol FROM stock_option_features_history "
        f"WHERE {_STOCK_OPTIONS} AND trade_date = CAST(? AS DATE)",
        (date,),
    ).fetchall()
    return {r[0] for r in rows}


def is_covered(conn, date: str) -> bool:
    """True only when `date` itself has rows in the series, not merely when it lies between
    `fno_series_coverage`'s first and last (the range has interior holes)."""
    return conn.execute(
        "SELECT 1 FROM stock_option_features_history "
        f"WHERE {_STOCK_OPTIONS} AND trade_date = CAST(? AS DATE) LIMIT 1",
        (date,),
    ).fetchone() is not None


def fno_series_coverage(conn) -> tuple[str, str]:
    """First and last date a dated series exists. The range is NOT contiguous: use `is_covered`
    per date. The caller bounds the F&O tier's verdict to it."""
    first, last = conn.execute(
        "SELECT MIN(trade_date), MAX(trade_date) FROM stock_option_features_history "
        f"WHERE {_STOCK_OPTIONS}"
    ).fetchone()
    if first is None:
        raise ValueError("no dated F&O series: stock_option_features_history has no OPTSTK rows")
    return str(first), str(last)
