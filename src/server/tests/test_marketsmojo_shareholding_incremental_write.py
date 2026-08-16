"""
Pins the incremental-write guard in marketsmojo_shareholding_fetcher.write_shareholding_history.

Why this exists separately from test_marketsmojo_incremental_write.py: that file covers the
*technical* fetcher, whose period column is TEXT and whose parsed dates are already strings, so
its guard compares str to str and always worked. The shareholding fetcher has the same guard
shape but NOT the same types -- _flatten_blocks yields datetime.date (via _yyyymm_to_date)
while load_known_max_dates returns ISO text -- and `period_date <= since` raised

    TypeError: '<=' not supported between instances of 'datetime.date' and 'str'

on every symbol that already had stored history, i.e. the entire incremental path, which is the
only path the guard exists for. The whole run aborted; caught live in the pm2 logs 2026-08-16,
not by any test. The near-identical sibling passing its own tests is exactly why this needed its
own coverage: a shared bug SHAPE does not mean shared types.

Negative control (run 2026-08-16): restoring `if since and period_date and period_date <= since`
makes test_skips_periods_already_stored and test_date_typed_period_does_not_raise fail with that
TypeError; test_first_run_writes_everything passes either way (known={} never reaches the
comparison) and is the control that the guard is not simply skipping everything.

Runs against REAL Postgres via the pg_conn fixture, auto-skipping when Postgres is unreachable.
"""

import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from conftest import pg_available  # noqa: E402
from marketsmojo_shareholding_fetcher import (  # noqa: E402
    load_known_max_dates,
    write_shareholding_history,
)

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")

# date objects, matching what _flatten_blocks actually produces -- NOT strings. Using strings
# here would reproduce the sibling fetcher's types and test nothing.
ROWS = [
    ("promoter_pct", date(2026, 3, 31), 55.0),
    ("promoter_pct", date(2026, 6, 30), 56.0),
    ("fii_pct", date(2026, 6, 30), 12.5),
]


@pytest.fixture
def db(pg_conn):
    pg_conn.execute("""
        CREATE TABLE marketsmojo_shareholding_history (
            symbol TEXT, category TEXT, period_date DATE,
            value REAL, fetched_at TEXT,
            PRIMARY KEY (symbol, category, period_date)
        )
    """)
    pg_conn.commit()
    return pg_conn


def test_first_run_writes_everything(db):
    assert write_shareholding_history(db, "TESTSYM", ROWS, "2026-08-16", known={}) == 3


def test_date_typed_period_does_not_raise(db):
    """The regression itself: a date-typed period against ISO-text `known` must not TypeError."""
    write_shareholding_history(db, "TESTSYM", ROWS, "2026-08-16", known={})
    known = load_known_max_dates(db)
    write_shareholding_history(db, "TESTSYM", ROWS, "2026-08-17", known=known)


def test_skips_periods_already_stored(db):
    write_shareholding_history(db, "TESTSYM", ROWS, "2026-08-16", known={})
    known = load_known_max_dates(db)
    assert known[("TESTSYM", "promoter_pct")] == "2026-06-30"

    # Same payload again: every period is now <= the stored max, so nothing may be rewritten.
    assert write_shareholding_history(db, "TESTSYM", ROWS, "2026-08-17", known=known) == 0


def test_newer_period_still_written(db):
    """Control: the guard must skip only what is already held, not everything."""
    write_shareholding_history(db, "TESTSYM", ROWS, "2026-08-16", known={})
    known = load_known_max_dates(db)
    newer = [("promoter_pct", date(2026, 9, 30), 57.0)]
    assert write_shareholding_history(db, "TESTSYM", newer, "2026-08-17", known=known) == 1


def test_unseen_category_is_not_skipped_by_another_categorys_high_water_mark(db):
    """The guard keys on (symbol, category); a populated category must not suppress a new one."""
    known = {("TESTSYM", "promoter_pct"): "2026-12-31"}
    assert write_shareholding_history(db, "TESTSYM", ROWS, "2026-08-16", known=known) == 1
