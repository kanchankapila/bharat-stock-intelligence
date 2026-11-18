"""investsights_pe_band_fetcher keeps the first band it saw for each date (AF-20261019-02).

The vendor rebuilds every historical chart point from its CURRENT bands, so a re-upsert rewrote
three years of rows with later information (ACC: 767 rows, 5 distinct band_median values). A
stored row must keep the value captured on its first run, and a run writes only dates newer
than the symbol's latest stored date.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_pe_band_fetcher as pb  # noqa: E402


def _chart(*points):
    return {"chart": [{"date": d, "price": 100.0, "pe": 20.0, "band_low": 10.0, "band_mid_low": 15.0,
                       "band_median": m, "band_mid_high": 25.0, "band_high": 30.0} for d, m in points]}


def _medians(conn):
    rows = conn.execute("SELECT date::text, band_median FROM investsights_pe_band_history "
                        "WHERE symbol = 'ACC' ORDER BY date").fetchall()
    return [(r[0], float(r[1])) for r in rows]


def test_a_later_run_never_rewrites_a_stored_date():
    conn = pg_memory_conn()
    pb.ensure_schema(conn)
    pb.store_rows(conn, pb.parse_chart_rows("ACC", _chart(("2026-11-17", 18.0))))
    rows = pb.parse_chart_rows("ACC", _chart(("2026-11-17", 21.0), ("2026-11-18", 21.0)))
    written = pb.store_rows(conn, rows, pb.load_known_max_dates(conn))
    assert _medians(conn) == [("2026-11-17", 18.0), ("2026-11-18", 21.0)]
    assert written == 1


def test_a_point_after_the_latest_completed_session_waits_for_the_next_run():
    conn = pg_memory_conn()
    pb.ensure_schema(conn)
    rows = pb.parse_chart_rows("ACC", _chart(("2026-11-17", 18.0), ("2026-11-18", 19.0)))
    assert pb.store_rows(conn, rows, {}, through="2026-11-17") == 1     # 11-18 still in progress
    later = pb.parse_chart_rows("ACC", _chart(("2026-11-17", 30.0), ("2026-11-18", 21.0)))
    pb.store_rows(conn, later, pb.load_known_max_dates(conn), through="2026-11-18")
    assert _medians(conn) == [("2026-11-17", 18.0), ("2026-11-18", 21.0)]


def test_only_dates_after_the_latest_stored_date_are_written():
    conn = pg_memory_conn()
    pb.ensure_schema(conn)
    pb.store_rows(conn, pb.parse_chart_rows("ACC", _chart(("2026-11-10", 18.0))))
    # A gap date older than the stored maximum is not back-filled with today's restated band.
    rows = pb.parse_chart_rows("ACC", _chart(("2026-11-05", 21.0), ("2026-11-10", 21.0), ("2026-11-11", 21.0)))
    assert pb.store_rows(conn, rows, pb.load_known_max_dates(conn)) == 1
    assert _medians(conn) == [("2026-11-10", 18.0), ("2026-11-11", 21.0)]
