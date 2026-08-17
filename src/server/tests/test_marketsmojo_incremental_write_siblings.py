"""
Pins the incremental-write guard added 2026-08-14 to the 4 marketsmojo sibling fetchers that
never got test_marketsmojo_incremental_write.py's fix (fetcher-accuracy-review found
marketsmojo_technical_fetcher.py's guard applied to only 1 of 5 -- financials_history already at
4,144,255 rows after exactly one run, 2026-08-11). Same shape as that file's tests; one file
covering all 4 since the fix pattern is identical (skip already-known dates/values).
"""

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
from marketsmojo_fintrend_fetcher import (  # noqa: E402
    load_known_max_dates as fintrend_known,
    write_fintrend_history,
)
from marketsmojo_shareholding_fetcher import (  # noqa: E402
    load_known_max_dates as shareholding_known,
    write_shareholding_history,
)
from marketsmojo_index_fetcher import (  # noqa: E402
    load_known_max_dates as index_known,
    write_index_history,
)
from marketsmojo_financials_fetcher import (  # noqa: E402
    load_known_values as financials_known,
    write_financials_history,
)


def _fintrend_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE marketsmojo_fintrend_history (
            symbol TEXT, date TEXT, score REAL, fin_trend_dir TEXT, fin_txt TEXT, fetched_at TEXT,
            PRIMARY KEY (symbol, date)
        );
    """)
    return conn


def test_fintrend_skips_dates_already_stored():
    conn = _fintrend_db()
    rows = [{"date": "2026-08-10", "score": 5}, {"date": "2026-08-11", "score": 6}]
    write_fintrend_history(conn, "TESTSYM", rows, "2026-08-11", known={"TESTSYM": "2026-08-10"})
    known = fintrend_known(conn)
    assert known["TESTSYM"] == "2026-08-11"
    # NEGATIVE CONTROL shape: re-sending the same payload with the fresh high-water mark
    # must write nothing.
    assert write_fintrend_history(conn, "TESTSYM", rows, "2026-08-12", known=known) == 0


def _shareholding_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE marketsmojo_shareholding_history (
            symbol TEXT, category TEXT, period_date TEXT, value REAL, fetched_at TEXT,
            PRIMARY KEY (symbol, category, period_date)
        );
    """)
    return conn


def test_shareholding_skips_periods_already_stored():
    conn = _shareholding_db()
    rows = [("promoter", "2026-06-30", 45.0), ("promoter", "2026-03-31", 46.0)]
    write_shareholding_history(conn, "TESTSYM", rows, "2026-07-01",
                                known={("TESTSYM", "promoter"): "2026-03-31"})
    known = shareholding_known(conn)
    assert known[("TESTSYM", "promoter")] == "2026-06-30"
    assert write_shareholding_history(conn, "TESTSYM", rows, "2026-07-02", known=known) == 0


def _index_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE marketsmojo_index_history (
            index_id INTEGER, name TEXT, date TEXT, price REAL, fetched_at TEXT,
            PRIMARY KEY (index_id, date)
        );
    """)
    return conn


def test_index_skips_dates_already_stored():
    conn = _index_db()
    rows = [{"date": "2026-08-10", "price": 100.0}, {"date": "2026-08-11", "price": 101.0}]
    write_index_history(conn, 1, "NIFTY 50", rows, "2026-08-11", known={1: "2026-08-10"})
    known = index_known(conn)
    assert known[1] == "2026-08-11"
    assert write_index_history(conn, 1, "NIFTY 50", rows, "2026-08-12", known=known) == 0


def _financials_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE marketsmojo_financials_history (
            symbol TEXT, statement TEXT, period_label TEXT, line_item TEXT,
            value REAL, fetched_at TEXT,
            PRIMARY KEY (symbol, statement, period_label, line_item)
        );
    """)
    return conn


def test_financials_skips_unchanged_values_but_writes_changed_ones():
    conn = _financials_db()
    rows = [("income", "FY24", "revenue", "1000"), ("income", "FY23", "revenue", "900")]
    write_financials_history(conn, "TESTSYM", rows, "2026-08-11", known={})
    known = financials_known(conn, "TESTSYM")
    assert known[("income", "FY24", "revenue")] == 1000.0

    # Same values again -> nothing written (this is the write-amplification fix: old, unchanged
    # periods must not be re-upserted just because the API returns the whole series every call).
    assert write_financials_history(conn, "TESTSYM", rows, "2026-08-12", known=known) == 0

    # A genuinely revised figure (vendor restatement) must still get written.
    revised = [("income", "FY24", "revenue", "1050"), ("income", "FY23", "revenue", "900")]
    assert write_financials_history(conn, "TESTSYM", revised, "2026-08-13", known=known) == 1


def test_financials_full_rerun_upserts_everything_regardless_of_known():
    conn = _financials_db()
    rows = [("income", "FY24", "revenue", "1000")]
    write_financials_history(conn, "TESTSYM", rows, "2026-08-11", known={})
    # --full passes known=None
    assert write_financials_history(conn, "TESTSYM", rows, "2026-08-12", known=None) == 1


def test_NEGATIVE_CONTROL_new_unparseable_cell_is_written_not_skipped():
    """known.get(key) == value can't tell "key never seen before" from "key stored as NULL" --
    both read as None from a plain dict.get on a miss. A brand-new symbol's known={} plus a
    cell whose raw_value is a placeholder ('-', 'N/A') parses to None, and None == None was
    True -- so the very first write for that cell was silently skipped forever, unlike every
    other new row (which the pre-fix code unconditionally wrote). Fails against
    `known.get(key) == value` (with no `key in known` guard), passes against the fix."""
    conn = _financials_db()
    rows = [("income", "FY24", "revenue", "-")]  # unparseable placeholder -> None
    written = write_financials_history(conn, "TESTSYM", rows, "2026-08-11", known={})
    assert written == 1, "a never-before-seen cell must be written even if it parses to NULL"
    stored = conn.execute(
        "SELECT COUNT(*) FROM marketsmojo_financials_history WHERE symbol = 'TESTSYM'"
    ).fetchone()[0]
    assert stored == 1
