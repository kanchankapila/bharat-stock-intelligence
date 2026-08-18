"""
Pins the per-symbol staleness skip in marketsmojo_financials_fetcher.py (AF-20260816-20).

Why this exists: run() used to fetch EVERY symbol's full HTTP response before it could even look
at load_known_values() (a per-CELL diff, only usable after the response is already in hand), so
an already-current symbol still cost a full round-trip every single weekly run. The fix is a
separate per-symbol "we already asked" marker (marketsmojo_financials_checked,
migration 1787090000000), independent of marketsmojo_financials_history.fetched_at -- that column
only advances on a genuine value change, so a symbol with stable financials would look
permanently stale and never get skipped if it were used for this instead.

Negative control: reverting load_recently_checked/mark_checked (or the `if symbol in
recently_checked: continue` in run()) makes test_recently_checked_symbol_is_excluded fail, since
load_recently_checked would return an empty set / nothing would ever be marked.

Runs against real Postgres via the pg_conn fixture, same pattern as
test_marketsmojo_incremental_write.py. Auto-skips if Postgres is unreachable.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from conftest import pg_available  # noqa: E402
from marketsmojo_financials_fetcher import (  # noqa: E402
    load_recently_checked,
    mark_checked,
)

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")


@pytest.fixture
def db(pg_conn):
    pg_conn.execute("""
        CREATE TABLE marketsmojo_financials_checked (
            symbol TEXT PRIMARY KEY, checked_at TIMESTAMPTZ NOT NULL
        )
    """)
    pg_conn.commit()
    return pg_conn


def test_never_checked_symbol_is_not_excluded(db):
    assert load_recently_checked(db) == set()


def test_recently_checked_symbol_is_excluded(db):
    mark_checked(db, "TESTSYM")
    assert "TESTSYM" in load_recently_checked(db)
    assert load_recently_checked(db, staleness_days=0) == set()  # 0-day window: nothing is stale


def test_mark_checked_is_idempotent_upsert(db):
    mark_checked(db, "TESTSYM")
    mark_checked(db, "TESTSYM")  # must not raise a PK violation
    rows = db.execute("SELECT count(*) AS n FROM marketsmojo_financials_checked").fetchone()
    assert rows["n"] == 1


def test_old_checked_row_falls_outside_the_staleness_window(db):
    db.execute(
        "INSERT INTO marketsmojo_financials_checked (symbol, checked_at) "
        "VALUES ('OLDSYM', NOW() - INTERVAL '30 days')"
    )
    db.commit()
    assert "OLDSYM" not in load_recently_checked(db, staleness_days=7)
