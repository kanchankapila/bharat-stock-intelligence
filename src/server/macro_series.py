"""India VIX as one series, whichever name stored it.

macro_asset_prices holds India VIX twice: 'INDIAVIX' (global_macro_fetcher / nt_vix_fetcher /
mc_index_ohlc_fetcher, history from 2020) and 'INDIA_VIX' (market_regime_fetcher, from 2026-07).
Readers picked one name each. Stored rows are deliberately not renamed; this reads both, one
row per date, preferring INDIAVIX (the longer history) and falling back to INDIA_VIX only where
INDIAVIX has no non-NULL close.
"""
from __future__ import annotations

import pandas as pd

INDIA_VIX_NAMES = ("INDIAVIX", "INDIA_VIX")

INDIA_VIX_SQL = """
    SELECT DISTINCT ON (date) date, close
    FROM macro_asset_prices
    WHERE symbol IN ('INDIAVIX', 'INDIA_VIX') AND close IS NOT NULL
      AND (CAST(? AS date) IS NULL OR date >= CAST(? AS date))
      AND (CAST(? AS date) IS NULL OR date <= CAST(? AS date))
    ORDER BY date, (symbol <> 'INDIAVIX')
"""


def read_india_vix(conn=None, start: str | None = None, end: str | None = None) -> pd.Series:
    """date -> close, ascending. `conn` is any db_compat connection; None uses the shared engine."""
    params = (start, start, end, end)
    if conn is None:
        from db_compat import read_df
        df = read_df(INDIA_VIX_SQL, params)
        return pd.Series(df["close"].astype(float).values, index=list(df["date"]), name="india_vix")
    rows = conn.execute(INDIA_VIX_SQL, params).fetchall()
    return pd.Series([float(r[1]) for r in rows], index=[r[0] for r in rows], name="india_vix")
