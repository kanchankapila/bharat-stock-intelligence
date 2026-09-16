"""NaN must never reach Postgres from analyst_revision.py.

Live failure 2026-09-05 (ml-daily-ops step `analyst_revision`, the run's only failure of 20):

    sqlalchemy.exc.DataError: (psycopg2.errors.NumericValueOutOfRange) bigint out of range
    [parameters: ... {'p0': nan, 'p1': 234.76190476190476, 'p2': 18.0, 'p3': 'ABB', ...}]

Two defects compound here, and the second is what makes the first fatal:

1. `compute_revisions()` correctly produces Python `None` for a missing metric -- but it
   returns `pd.DataFrame(results)`, and pandas silently converts `None` to `NaN` in a float64
   column. So `write_revisions`'s guard `if r.eps_revision_3m_pct is None and ...` can NEVER
   fire: a NaN is not None. Rows meant to be skipped are written instead.

2. `technical_signals.analyst_count_chg` is **bigint** (verified via information_schema), and
   Postgres cannot cast NaN to an integer type -- it reports it as "bigint out of range",
   which reads like an overflow and sends you looking for a huge number that isn't there.

The module already has NaN-safe `_float`/`_int` helpers, and already uses them on the INPUT
side (lines 119-128). They were simply never applied on the write path -- `recurring-bugs.md`'s
"`float(x or 0)` on a model-output column" class in its other form: the guard exists, the call
site doesn't use it.

Fixed by coercing at the boundary and dropping the row when nothing survives. NaN becomes NULL,
never 0 -- a 0 here would be a fabricated "no analyst revision", indistinguishable afterwards
from a real unchanged estimate (the sentinel-instead-of-NULL class, explicitly not retroactively
fixable).

These three columns matter more than a normal bugfix: `measurement.md` records them as having
NEVER been written, calendar-blocked, with a predicted unblock of ~2026-09-05 -- today. The data
arrived exactly on schedule and this bug threw all of it away.
"""
import math
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analyst_revision import revision_row_params


def test_nan_becomes_none_not_zero():
    row = revision_row_params(float("nan"), 234.76, 18.0, "ABB", "2026-09-05")
    assert row is not None
    assert row[0] is None, "NaN must be NULL, never 0.0 -- a fabricated zero is unrecoverable"
    assert row[1] == 234.76
    assert row[2] == 18


def test_analyst_count_is_an_int_because_the_column_is_bigint():
    """The live failure: a float NaN cast to bigint reports as 'bigint out of range'."""
    row = revision_row_params(1.0, 2.0, 18.0, "ABB", "2026-09-05")
    assert isinstance(row[2], int) and not isinstance(row[2], bool)
    assert row[2] == 18


def test_nan_analyst_count_becomes_none_rather_than_reaching_a_bigint_column():
    row = revision_row_params(1.0, 2.0, float("nan"), "ABB", "2026-09-05")
    assert row is not None and row[2] is None


def test_row_with_no_surviving_metric_is_dropped():
    """The guard that pandas' None->NaN conversion silently defeated."""
    assert revision_row_params(float("nan"), float("nan"), float("nan"), "X", "2026-09-05") is None
    assert revision_row_params(None, None, None, "X", "2026-09-05") is None


def test_a_genuine_zero_is_preserved():
    """0.0 is a real reading (estimates unchanged) and must not be confused with missing."""
    row = revision_row_params(0.0, 0.0, 0.0, "X", "2026-09-05")
    assert row is not None and row[0] == 0.0 and row[1] == 0.0 and row[2] == 0


def test_infinity_is_rejected_like_nan():
    """_pct_change divides by |prior|; a denormal prior can overflow to inf, which Postgres
    accepts into a float8 column and which then sorts HIGHEST in any ORDER BY."""
    row = revision_row_params(float("inf"), 1.0, 1.0, "X", "2026-09-05")
    assert row is not None and row[0] is None


def test_survives_the_pandas_none_to_nan_conversion_end_to_end():
    """Reproduces the actual production path: dicts holding None -> DataFrame -> itertuples."""
    # A column of ALL None stays `object` dtype and keeps its Nones; the conversion to NaN only
    # happens once at least one real float forces the column to float64. Production always has
    # that mix (1,052 symbols, most with real values), so the fixture must too -- an all-None
    # fixture would pass against the unfixed code and prove nothing.
    df = pd.DataFrame([
        {"symbol": "REAL", "eps_revision_3m_pct": -31.67, "target_revision_3m_pct": -37.62,
         "analyst_count_chg": 0},
        {"symbol": "ABB", "eps_revision_3m_pct": None, "target_revision_3m_pct": 234.76,
         "analyst_count_chg": 18},
        {"symbol": "SKIPME", "eps_revision_3m_pct": None, "target_revision_3m_pct": None,
         "analyst_count_chg": None},
    ])
    # Precondition: this is the trap being guarded against, so assert it really happens.
    assert math.isnan(df.iloc[1]["eps_revision_3m_pct"]), "pandas no longer converts None->NaN"

    out = [revision_row_params(r.eps_revision_3m_pct, r.target_revision_3m_pct,
                               r.analyst_count_chg, r.symbol, "2026-09-05")
           for r in df.itertuples(index=False)]
    kept = [r for r in out if r is not None]
    assert [k[3] for k in kept] == ["REAL", "ABB"], "SKIPME must be dropped, the others kept"
    abb = kept[1]
    assert abb[0] is None, "the NaN eps must become NULL"
    assert abb[2] == 18 and isinstance(abb[2], int), "bigint column needs a real int"
