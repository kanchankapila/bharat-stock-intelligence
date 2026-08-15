"""
Pins the incremental-write guard in marketsmojo_technical_fetcher.write_technical_history.

Why this exists: getCardInfo returns the stock's ENTIRE ~9,900-row series on every call, and
the fetcher used to re-upsert all of it nightly. Measured 2026-08-12 against production:
2,010,101 rows written to gain 2,787 new ones, which made a single symbol cost ~11s of DB time
and got the step SIGKILLed at its budget after 12% of the universe. No test could have caught
that -- the old code was *correct*, just quadratically wasteful -- so the assertion that matters
is the row COUNT, not the row content.

Negative control (run 2026-08-12): reverting the `if since and row_date <= since: continue`
guard makes test_skips_dates_already_stored fail with 3 != 1.

Runs against REAL Postgres (converted 2026-08-15, Phase 2 of docs/SQLITE_DECOMMISSION_PLAN.md,
via the `pg_conn` fixture) -- not the SQLite it ran against before. This function's `conn.execute`
calls are `db_compat.ConnWrapper`-shaped and go through `translate()` in production, which
SQLite-mode testing never exercised: the `INSERT ... ON CONFLICT(...) DO UPDATE` below is valid
SQLite syntax too, so the old test passed without ever running the real Postgres path. Auto-skips
if Postgres is unreachable (`pg_available()`), so this file degrades gracefully on a laptop with
no local Postgres and in any CI lane without the service container -- same class of test this
was before, not a new hard requirement.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))               # this dir, for conftest's pg_available
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))  # src/server, for the fetcher
from conftest import pg_available  # noqa: E402
from marketsmojo_technical_fetcher import (  # noqa: E402
    load_known_max_dates,
    write_technical_history,
)

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")

SERIES = {
    ("indigraph", "d"): [
        {"date": "2026-08-10", "price": 100.0, "grade": "Bullish", "flag": 1},
        {"date": "2026-08-11", "price": 101.0, "grade": "Bullish", "flag": 1},
        {"date": "2026-08-12", "price": 102.0, "grade": "Neutral", "flag": 0},
    ],
}


@pytest.fixture
def db(pg_conn):
    pg_conn.execute("""
        CREATE TABLE marketsmojo_technical_history (
            symbol TEXT, indicator TEXT, period TEXT, date TEXT,
            price REAL, grade TEXT, flag INTEGER, details TEXT, fetched_at TEXT,
            PRIMARY KEY (symbol, indicator, period, date)
        )
    """)
    pg_conn.commit()
    return pg_conn


def test_first_run_writes_the_whole_series(db):
    assert write_technical_history(db, "TESTSYM", SERIES, "2026-08-12", known={}) == 3


def test_skips_dates_already_stored(db):
    write_technical_history(db, "TESTSYM", SERIES, "2026-08-11",
                            known={("TESTSYM", "indigraph", "d"): "2026-08-11"})
    known = load_known_max_dates(db)
    assert known[("TESTSYM", "indigraph", "d")] == "2026-08-12"

    # Same payload again: everything is now <= the stored max, so nothing may be rewritten.
    assert write_technical_history(db, "TESTSYM", SERIES, "2026-08-13", known=known) == 0


def test_full_rerun_still_upserts_everything(db):
    """--full passes known=None -- a vendor restatement has to be able to overwrite history."""
    write_technical_history(db, "TESTSYM", SERIES, "2026-08-12", known={})
    assert write_technical_history(db, "TESTSYM", SERIES, "2026-08-13", known=None) == 3
    row = db.execute(
        "SELECT fetched_at FROM marketsmojo_technical_history WHERE date = '2026-08-10'"
    ).fetchone()
    assert row["fetched_at"] == "2026-08-13"


def test_unseen_series_is_not_skipped_by_another_symbols_high_water_mark(db):
    """The guard keys on (symbol, indicator, period); a busy symbol must not suppress a new one."""
    known = {("OTHERSYM", "indigraph", "d"): "2026-08-12"}
    assert write_technical_history(db, "TESTSYM", SERIES, "2026-08-12", known=known) == 3
