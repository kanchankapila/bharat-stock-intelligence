"""
Shared point-in-time ("as-of") data-access helper.

Every consumer that needs "the most recent snapshot of a slow-moving fact (fundamentals,
analyst estimates, ...) known as of a given date" was hand-rolling the same correlated-subquery
SQL fragment independently in ml_ensemble.py (6x), exit_policy.py, online_learner.py,
cs_ranker.py (3x), confluence_ml_engine.py -- or a bespoke pandas merge_asof in
feature_engineering.py. This is the ONE place that pattern lives now. A test
(tests/test_as_of_no_hand_rolled_joins.py) fails CI if a new hand-rolled "as of date" join is
added anywhere else under src/server, so this doesn't quietly re-drift.
"""
from typing import Sequence

import pandas as pd

from db_compat import read_df


def as_of_join_sql(hist_table: str, alias: str, base_alias: str, base_symbol_col: str,
                    base_date_col: str) -> str:
    """A LEFT JOIN fragment pulling the most recent `hist_table` row for
    `base_alias.base_symbol_col` as of `base_alias.base_date_col` (inclusive).

    Semantically identical to every hand-rolled version this replaces (verified against
    exit_policy.py/cs_ranker.py's pre-migration SQL in tests/test_as_of.py):

        LEFT JOIN <hist_table> <alias>
               ON <alias>.symbol = <base_alias>.<base_symbol_col>
              AND <alias>.as_of_date = (
                  SELECT MAX(<alias>2.as_of_date) FROM <hist_table> <alias>2
                  WHERE <alias>2.symbol = <base_alias>.<base_symbol_col>
                    AND <alias>2.as_of_date <= <base_alias>.<base_date_col>
              )

    `hist_table` is a fixed set of internal table names (never user input) -- safe to
    interpolate directly, matching every call site's existing convention.
    """
    alias2 = f"{alias}2"
    return (
        f"LEFT JOIN {hist_table} {alias}\n"
        f"       ON {alias}.symbol = {base_alias}.{base_symbol_col}\n"
        f"      AND {alias}.as_of_date = (\n"
        f"          SELECT MAX({alias2}.as_of_date) FROM {hist_table} {alias2}\n"
        f"          WHERE {alias2}.symbol = {base_alias}.{base_symbol_col} "
        f"AND {alias2}.as_of_date <= {base_alias}.{base_date_col}\n"
        f"      )"
    )


def read_as_of_history(table: str, symbol: str, columns: Sequence[str]) -> pd.DataFrame:
    """Load a symbol's full as-of history from `table` (as_of_date + the given columns),
    normalized to a sorted, NaT-free, datetime64[ns] `as_of_date` column ready for
    pandas.merge_asof. Extracted from feature_engineering.py's _merge_fundamentals, which
    hand-rolled this same "load, normalize dtype, dropna, sort" boilerplate -- including the
    dtype-resolution fix documented there (PG timestamptz vs SQLite text-parsed as_of_date can
    come back as different datetime64 resolutions; merge_asof requires an exact dtype match).
    """
    cols_sql = ", ".join(["as_of_date"] + list(columns))
    hist = read_df(f"SELECT {cols_sql} FROM {table} WHERE symbol = ? ORDER BY as_of_date", (symbol,))
    if hist.empty:
        return hist
    hist["as_of_date"] = pd.to_datetime(hist["as_of_date"]).astype("datetime64[ns]")
    return hist.dropna(subset=["as_of_date"]).sort_values("as_of_date")
