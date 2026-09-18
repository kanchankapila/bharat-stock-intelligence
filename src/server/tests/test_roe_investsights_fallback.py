"""feature_store.roe falls back to InvestSights ROE ONLY where Yahoo's is missing, point-in-time.

AF-20260917-07. Yahoo's `returnOnEquity` decayed from 86% to 6.1% of the universe (2026-07-02 ->
2026-08-23) while `fundamentals_history` stayed fresh, so `_merge_fundamentals` produced NaN ROE
for ~94% of names. `investsights_fundamentals_history.return_on_equity` measured Pearson 0.9608
against the yfinance value, same fraction scale, zero sign flips, and now fills only those gaps.

Four properties are pinned, each a way this could go wrong silently:
  1. a gap is filled from InvestSights;
  2. yfinance stays PRIMARY where present (the fallback must not overwrite it);
  3. the join is POINT-IN-TIME -- an InvestSights row fetched AFTER the feature date must not be
     used (that would be look-ahead; the live verification caught exactly this case with a
     symbol whose only InvestSights row came from the same day's widened fetch);
  4. with no InvestSights row the value stays NaN -- never a sentinel.

DB-backed against a throwaway Postgres schema (`pg_db_conn`); the reload order matters because
`as_of` imports `read_df` from `db_compat` at import time and `feature_engineering` imports
`read_as_of_history` from `as_of`.

Negative control: remove the fallback block from `_merge_fundamentals` and
`test_gap_is_filled_from_investsights` fails (the value stays NaN).
"""
import importlib
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _fe():
    import db_compat
    importlib.reload(db_compat)
    import as_of
    importlib.reload(as_of)
    import feature_engineering
    importlib.reload(feature_engineering)
    return feature_engineering.FeatureEngineer.__new__(feature_engineering.FeatureEngineer)


def _roe(fe, symbol, dates):
    idx = pd.DatetimeIndex(pd.to_datetime(dates), name="date")
    return fe._merge_fundamentals(pd.DataFrame(index=idx), symbol)["roe"].tolist()


def _seed(conn, rows_fh=(), rows_is=()):
    for sym, d, roe in rows_fh:
        conn.execute("INSERT INTO fundamentals_history (symbol, as_of_date, return_on_equity) "
                     "VALUES (?, ?, ?)", (sym, d, roe))
    for sym, d, roe in rows_is:
        conn.execute("INSERT INTO investsights_fundamentals_history "
                     "(symbol, fetched_date, return_on_equity) VALUES (?, ?, ?)", (sym, d, roe))
    conn.commit()


def test_gap_is_filled_from_investsights(pg_db_conn):
    # Yahoo row exists but ROE is NULL (the decayed case), InvestSights has it.
    _seed(pg_db_conn,
          rows_fh=[("X", "2026-09-01", None)],
          rows_is=[("X", "2026-09-01", 0.2954)])
    (v,) = _roe(_fe(), "X", ["2026-09-10"])
    assert v == pytest.approx(0.2954), f"gap not filled from InvestSights: {v!r}"


def test_yfinance_stays_primary_where_present(pg_db_conn):
    _seed(pg_db_conn,
          rows_fh=[("X", "2026-09-01", 0.1913)],
          rows_is=[("X", "2026-09-01", 0.2129)])
    (v,) = _roe(_fe(), "X", ["2026-09-10"])
    assert v == pytest.approx(0.1913), (
        f"the fallback overwrote a present yfinance value ({v!r}) -- it must only fill gaps")


def test_fallback_is_point_in_time_no_look_ahead(pg_db_conn):
    """An InvestSights row fetched AFTER the feature date must not reach back in time."""
    _seed(pg_db_conn,
          rows_fh=[("X", "2026-08-01", None)],
          rows_is=[("X", "2026-09-18", 0.30)])
    before, after = _roe(_fe(), "X", ["2026-09-10", "2026-09-18"])
    assert pd.isna(before), f"look-ahead: a 2026-09-18 fetch was used for 2026-09-10 ({before!r})"
    assert after == pytest.approx(0.30)


def test_no_source_leaves_nan_not_a_sentinel(pg_db_conn):
    _seed(pg_db_conn, rows_fh=[("X", "2026-09-01", None)])
    (v,) = _roe(_fe(), "X", ["2026-09-10"])
    assert pd.isna(v), f"missing ROE became {v!r} -- a sentinel is invisible to coverage checks"
