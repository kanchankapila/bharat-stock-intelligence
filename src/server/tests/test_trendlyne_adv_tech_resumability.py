"""
Pins _load_stocks()'s resumability filter in trendlyne_adv_tech_fetcher.py.

Why this exists: the job has no since-parameter analogue -- every catch-up retry (BullMQ's
addJobWithCatchup, fired on every pm2 restart if the scheduled run is judged "missed") re-fetched
the FULL ~2200-stock universe from scratch, so a run killed by the outer 40-min timeout near
completion threw away that progress and started over. Live-traced 2026-08-15: the endpoint and
fetch logic are both healthy in isolation (300/300 stocks succeeded, ~2.5min projected
full-universe run) -- the recurring 40-min kills (24 of the last 31 job_heartbeat runs) trace to
this machine's shared Python-subprocess pool getting starved by concurrent long-running jobs, not
to this fetcher's own code. Resumability doesn't fix the contention, but it stops one slow day
from becoming a total-failure day: each retry only has to cover what's still missing.

Negative control (run 2026-08-15): reverting the `if skip_done_for_date: ...` filter block makes
test_already_fetched_symbols_are_skipped fail (returns all 3 stocks instead of 1).

Runs against real Postgres via pg_conn (see test_marketsmojo_incremental_write.py for the same
pattern) -- auto-skips if Postgres is unreachable.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from conftest import pg_available  # noqa: E402
from trendlyne_adv_tech_fetcher import _load_stocks, ensure_schema  # noqa: E402

pytestmark = pytest.mark.skipif(not pg_available(), reason="live Postgres not reachable")


@pytest.fixture
def db(pg_conn):
    # pg_schema's search_path puts the throwaway schema FIRST, so a local nse_stocks here
    # shadows the real one for the rest of this connection -- _load_stocks()'s unqualified
    # "FROM nse_stocks" must never resolve to production. Minimal columns only (symbol, tlid),
    # not the real ~30-column table -- this test only exercises the resolution/filter logic.
    cur = pg_conn.cursor()
    cur.execute("CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, tlid TEXT)")
    ensure_schema(pg_conn)
    for sym, tlid in [("TESTA", "900001"), ("TESTB", "900002"), ("TESTC", "900003")]:
        cur.execute("INSERT INTO nse_stocks (symbol, tlid) VALUES (?, ?)", (sym, tlid))
    pg_conn.commit()
    return pg_conn


def test_no_date_filter_returns_everything(db):
    rows = _load_stocks(None, db)
    symbols = {s for s, _ in rows}
    assert {"TESTA", "TESTB", "TESTC"} <= symbols


def test_already_fetched_symbols_are_skipped(db):
    cur = db.cursor()
    cur.execute(
        "INSERT INTO trendlyne_adv_tech_daily (symbol, date, fetched_at) "
        "VALUES (?, ?, CURRENT_TIMESTAMP), (?, ?, CURRENT_TIMESTAMP)",
        ("TESTA", "2026-08-15", "TESTB", "2026-08-15"),
    )
    db.commit()

    rows = _load_stocks(None, db, skip_done_for_date="2026-08-15")
    symbols = {s for s, _ in rows if s in ("TESTA", "TESTB", "TESTC")}
    assert symbols == {"TESTC"}


def test_a_different_date_is_not_treated_as_done(db):
    cur = db.cursor()
    cur.execute(
        "INSERT INTO trendlyne_adv_tech_daily (symbol, date, fetched_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        ("TESTA", "2026-08-14"),
    )
    db.commit()

    rows = _load_stocks(None, db, skip_done_for_date="2026-08-15")
    symbols = {s for s, _ in rows if s in ("TESTA", "TESTB", "TESTC")}
    assert symbols == {"TESTA", "TESTB", "TESTC"}
