import sys
import os
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from pg_test_support import pg_memory_conn  # noqa: E402
from delivery_trend_fetcher import compute_delivery_trend


def _throwaway_db(conn):
    """Create just the two tables this test needs inside the fixture's throwaway schema.

    Deliberately narrow rather than the full production shape: the inserts below use bare
    `VALUES (?, ?, ?)` with no column list, which only lines up against a table of exactly this
    width. Converted from pg_memory_conn() by SQLITE_DECOMMISSION_PLAN Phase 2 -- the
    DDL is unchanged apart from being run through real Postgres, which is the point.
    """
    conn.execute("""
        CREATE TABLE stock_delivery_volume (
            symbol TEXT NOT NULL, date TEXT NOT NULL, delivery_pct DOUBLE PRECISION,
            PRIMARY KEY (symbol, date)
        )
    """)
    conn.execute("CREATE TABLE technical_signals (symbol TEXT, date TEXT, delivery_trend_30d DOUBLE PRECISION)")
    return conn


class TestDeliveryTrendAnchor:
    """2026-08-13 regression: compute_delivery_trend used raw date.today() for both the write
    target (ts.date = today) and the source lookup (cur.date = today) -- an exact-match WHERE,
    so on any day date.today() didn't match a real row (which was EVERY day: confirmed live,
    0/69,459 technical_signals rows ever got delivery_trend_30d) it silently updated 0 rows.
    Fixed to anchor on stock_delivery_volume's OWN latest date instead. Negative control:
    reverting to date.today() makes test_anchors_to_source_tables_own_latest_date fail whenever
    the test's synthetic "latest data" isn't today (the realistic case, since delivery data is
    always at least a day old by the time this runs)."""

    def test_anchors_to_source_tables_own_latest_date(self, pg_conn):
        con = _throwaway_db(pg_conn)
        # Synthetic delivery data as of an OLD date, deliberately not date.today() -- matches
        # real production shape (delivery % is always at least a day stale).
        stale_date = "2020-01-15"
        cutoff = (date.fromisoformat(stale_date) - timedelta(days=40)).isoformat()
        for i in range(5):
            d = (date.fromisoformat(cutoff) + timedelta(days=i * 7)).isoformat()
            con.execute("INSERT INTO stock_delivery_volume VALUES (?, ?, ?)", ("TEST", d, 40.0 + i))
        con.execute("INSERT INTO stock_delivery_volume VALUES (?, ?, ?)", ("TEST", stale_date, 55.0))
        con.execute("INSERT INTO technical_signals VALUES (?, ?, NULL)", ("TEST", stale_date))
        con.commit()

        n = compute_delivery_trend(con)
        assert n == 1, f"expected 1 row updated (anchored to {stale_date}), got {n}"

        row = con.execute(
            "SELECT delivery_trend_30d FROM technical_signals WHERE symbol='TEST' AND date=?",
            (stale_date,),
        ).fetchone()
        assert row["delivery_trend_30d"] is not None, (
            "delivery_trend_30d wasn't written -- anchor must have used date.today() instead "
            "of stock_delivery_volume's own latest date"
        )

    def test_empty_source_table_updates_nothing_without_crashing(self, pg_conn):
        con = _throwaway_db(pg_conn)
        n = compute_delivery_trend(con)
        assert n == 0
