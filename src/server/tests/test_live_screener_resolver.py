"""AF-20261003-10: the live-screener resolver resolved ONE page of MAX_PER_RUN rows per run while
~260k appearances arrive a day, so capacity sat below inflow and the newest outcome was 3+ weeks
old. It now drains pages (committed one at a time) until the backlog is empty or a budget is
spent, with a keyset cursor so a row that can never resolve cannot hold the head of every page."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

import live_screener_resolver as lsr  # noqa: E402

DATES = [f"2026-09-{d:02d}" for d in range(1, 12)]
CLOSES = [100.0 + i for i in range(len(DATES))]


def _db(appearances):
    """appearances: list of (id, symbol, price, created_at)."""
    conn = pg_memory_conn()
    conn.executescript("""
        CREATE TABLE live_screener_runs (id INTEGER PRIMARY KEY, created_at TEXT);
        CREATE TABLE live_screener_appearances (
            id INTEGER PRIMARY KEY, run_id INTEGER, symbol TEXT, filter_key TEXT, price REAL);
        CREATE TABLE live_screener_outcomes (
            appearance_id BIGINT PRIMARY KEY, symbol TEXT, filter_key TEXT, appeared_at TEXT,
            entry_price REAL, return_1d REAL, return_3d REAL, return_5d REAL, return_intraday REAL);
    """)
    for i, (app_id, symbol, price, created_at) in enumerate(appearances):
        conn.execute("INSERT INTO live_screener_runs (id, created_at) VALUES (?, ?)", (app_id, created_at))
        conn.execute("INSERT INTO live_screener_appearances (id, run_id, symbol, filter_key, price) "
                     "VALUES (?, ?, ?, 'F', ?)", (app_id, app_id, symbol, price))
    conn.commit()
    return conn


def _patch(monkeypatch, page):
    monkeypatch.setattr(lsr, "MAX_PER_RUN", page)
    monkeypatch.setattr(lsr, "try_advisory_lock", lambda name: True)
    monkeypatch.setattr(lsr, "release_advisory_lock", lambda name: None)
    monkeypatch.setattr(lsr, "prune_old_appearances", lambda conn: 0)
    monkeypatch.setattr(lsr, "_load_price_series",
                        lambda symbols, start: {"AAA": lsr._PriceSeries(DATES, CLOSES)})
    monkeypatch.setattr(lsr, "_load_intraday_close_series", lambda symbols, start, end: {})


def _outcome_ids(conn):
    return sorted(r[0] for r in conn.execute("SELECT appearance_id FROM live_screener_outcomes").fetchall())


def test_a_run_drains_every_page_not_just_the_first(monkeypatch):
    conn = _db([(i, "AAA", 100.0, "2026-09-01T04:00:00") for i in range(1, 6)])
    _patch(monkeypatch, page=2)

    lsr.resolve_outcomes(conn=conn)

    assert _outcome_ids(conn) == [1, 2, 3, 4, 5]


def test_one_page_budget_reproduces_the_old_starvation(monkeypatch):
    """Negative control: a zero budget stops after the first page, which is what every run did
    before the fix -- 2 of 5 here."""
    conn = _db([(i, "AAA", 100.0, "2026-09-01T04:00:00") for i in range(1, 6)])
    _patch(monkeypatch, page=2)

    lsr.resolve_outcomes(conn=conn, budget_s=-1)

    assert _outcome_ids(conn) == [1, 2]


def test_rows_that_can_never_resolve_do_not_hold_the_head_of_the_queue(monkeypatch):
    """Two oldest appearances have no price and no series -> every return is None -> no outcome
    row is ever written -> they stay pending. The cursor must skip past them."""
    rows = [(1, "ZZZ", None, "2026-09-01T04:00:00"), (2, "ZZZ", None, "2026-09-01T04:00:00")]
    rows += [(i, "AAA", 100.0, "2026-09-02T04:00:00") for i in range(3, 6)]
    conn = _db(rows)
    _patch(monkeypatch, page=2)

    lsr.resolve_outcomes(conn=conn)

    assert _outcome_ids(conn) == [3, 4, 5]


def test_dry_run_writes_nothing(monkeypatch):
    conn = _db([(i, "AAA", 100.0, "2026-09-01T04:00:00") for i in range(1, 4)])
    _patch(monkeypatch, page=2)

    lsr.resolve_outcomes(dry_run=True, conn=conn)

    assert _outcome_ids(conn) == []
