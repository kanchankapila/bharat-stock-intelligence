"""AF-20261008-A01/A02: event countdowns and flags must not be forward-filled.

Live 2026-10-06: 1,676 of 1,816 stored `days_to_next_results` values had no row in
stock_earnings_dates -- densify carried a "0 = reporting today" reading for up to 120 sessions
(RELIANCE read 0 every session from 07-17). `earnings_shocker_flag` was 1 on 1,933 of 2,160 names
for the same reason. Both columns are sparse (< 50% coverage), so sparse_columns() offered them
to the filler unless they are in NEVER_FILL.
"""
import densify_feature_matrix as densify

EVENT_CLOCKS = ("days_to_next_results", "earnings_shocker_flag")


def test_event_clock_columns_are_never_fill_candidates(pg_conn):
    conn = pg_conn
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date DATE,
            days_to_next_results DOUBLE PRECISION,
            earnings_shocker_flag DOUBLE PRECISION,
            some_fundamental DOUBLE PRECISION
        )
    """)
    for sym in ("AAA", "BBB", "CCC", "DDD"):
        conn.execute("INSERT INTO technical_signals VALUES (?, '2026-10-06', NULL, NULL, NULL)", (sym,))
    conn.commit()

    cols = densify.sparse_columns(conn, "2026-10-06")

    assert "some_fundamental" in cols, "control: an ordinary sparse column must still be fill-eligible"
    for c in EVENT_CLOCKS:
        assert c not in cols, f"{c} is a countdown/flag and must never be forward-filled"
