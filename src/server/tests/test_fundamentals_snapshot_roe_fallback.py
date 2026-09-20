"""fundamentals_snapshot fills fundamentals_history.return_on_equity from InvestSights, point-in-time.

Snapshot-side twin of test_roe_investsights_fallback.py (AF-20260917-07, wired 2026-09-20).
Yahoo's returnOnEquity decayed to 6.1% of the universe while stock_fundamentals kept answering,
so the daily snapshot copied the collapse into fundamentals_history and the critical
fundamentals-history-vendor-field-decay check failed 27 data-quality-daily runs in a row.
investsights_fundamentals_history.return_on_equity measured Pearson 0.9608 against yfinance,
same fraction scale, zero sign flips, and now fills only the gaps -- pinned here at the
SNAPSHOT level, because the snapshot is what the DQ check and every downstream reader
actually consume. Five properties, each a way this could go wrong silently:

  1. a gap is filled from InvestSights;
  2. a present stock_fundamentals value is never overwritten (Yahoo stays PRIMARY);
  3. the fill is POINT-IN-TIME -- an InvestSights row fetched AFTER the snapshot's as_of date
     must not be used (look-ahead);
  4. with no usable InvestSights row the value stays NULL -- never a sentinel;
  5. the snapshot stays idempotent per day (delete-then-insert).

DB-backed against the full production schema in a throwaway schema (`pg_db_conn`), like its
feature-side twin. Negative control: remove the COALESCE from _INSERT_SQL and
test_gap_is_filled_from_investsights fails (the value stays NULL).
"""
import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _snap():
    """Reload db_compat -> as_of -> fundamentals_snapshot so every `from db_compat import ...`
    binding points at the pg_db fixture's POSTGRES_URL (set before this runs). Same reload
    order rationale as test_roe_investsights_fallback.py's _fe()."""
    import db_compat
    importlib.reload(db_compat)
    import as_of
    importlib.reload(as_of)
    import fundamentals_snapshot
    importlib.reload(fundamentals_snapshot)
    return fundamentals_snapshot


def _seed(pg_db_conn, rows_sf=(), rows_isf=()):
    for sym, roe in rows_sf:
        pg_db_conn.execute(
            "INSERT INTO stock_fundamentals (symbol, return_on_equity) VALUES (?, ?)",
            (sym, roe),
        )
    for sym, fetched, roe in rows_isf:
        pg_db_conn.execute(
            "INSERT INTO investsights_fundamentals_history (symbol, fetched_date, return_on_equity) "
            "VALUES (?, ?, ?)",
            (sym, fetched, roe),
        )
    pg_db_conn.commit()


def _roe(snap, as_of, symbol="X"):
    rows = snap.query_all(
        "SELECT return_on_equity FROM fundamentals_history "
        "WHERE symbol = ? AND as_of_date = ?",
        (symbol, as_of),
    )
    return rows[0]["return_on_equity"] if rows else None


def test_gap_is_filled_from_investsights(pg_db_conn):
    # Yahoo row exists but ROE is NULL (the decayed case), InvestSights has it.
    _seed(pg_db_conn, rows_sf=[("X", None)], rows_isf=[("X", "2026-09-01", 0.2954)])
    snap = _snap()
    snap.snapshot_fundamentals("2026-09-10")
    v = _roe(snap, "2026-09-10")
    assert v == pytest.approx(0.2954), f"gap not filled from InvestSights: {v!r}"


def test_stock_fundamentals_stays_primary_where_present(pg_db_conn):
    _seed(pg_db_conn, rows_sf=[("X", 0.1913)], rows_isf=[("X", "2026-09-01", 0.2129)])
    snap = _snap()
    snap.snapshot_fundamentals("2026-09-10")
    v = _roe(snap, "2026-09-10")
    assert v == pytest.approx(0.1913), (
        f"the fallback overwrote a present stock_fundamentals value ({v!r}) -- it must only fill gaps"
    )


def test_fallback_is_point_in_time_no_look_ahead(pg_db_conn):
    """An InvestSights row fetched AFTER the snapshot's as_of date must not reach back in time."""
    _seed(pg_db_conn, rows_sf=[("X", None)], rows_isf=[("X", "2026-09-18", 0.30)])
    snap = _snap()
    snap.snapshot_fundamentals("2026-09-10")
    assert _roe(snap, "2026-09-10") is None, "look-ahead: a 2026-09-18 fetch was used for the 2026-09-10 snapshot"
    snap.snapshot_fundamentals("2026-09-18")
    assert _roe(snap, "2026-09-18") == pytest.approx(0.30)


def test_no_source_leaves_null_not_a_sentinel(pg_db_conn):
    _seed(pg_db_conn, rows_sf=[("X", None)])
    snap = _snap()
    snap.snapshot_fundamentals("2026-09-10")
    assert _roe(snap, "2026-09-10") is None, (
        f"missing ROE became {_roe(snap, '2026-09-10')!r} -- a sentinel is invisible to coverage checks"
    )


def test_snapshot_is_idempotent_per_day(pg_db_conn):
    _seed(pg_db_conn, rows_sf=[("X", None)], rows_isf=[("X", "2026-09-01", 0.2954)])
    snap = _snap()
    snap.snapshot_fundamentals("2026-09-10")
    snap.snapshot_fundamentals("2026-09-10")
    rows = snap.query_all(
        "SELECT return_on_equity FROM fundamentals_history WHERE symbol = 'X' AND as_of_date = '2026-09-10'"
    )
    assert len(rows) == 1, f"re-running the snapshot duplicated the day: {len(rows)} rows"
    assert rows[0]["return_on_equity"] == pytest.approx(0.2954)
