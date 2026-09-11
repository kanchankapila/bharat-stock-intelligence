"""db_compat.iter_rows: stream a large read as plain tuples instead of materialising Row objects.

ConnWrapper.execute(...).fetchall() builds a dict-subclass Row per row. Measured 2026-09-11 on
ohlcv_quality's read of stock_ohlcv (2.7M rows): 2,280MB peak Python heap via fetchall vs 380MB
streamed as tuples, and ~2.5x faster.
"""
from db_compat import iter_rows


def _table(conn, n=250):
    conn.execute("CREATE TABLE ir (symbol TEXT, d DATE, v DOUBLE PRECISION)")
    conn.executemany("INSERT INTO ir VALUES (?, ?, ?)",
                     [(f"S{i % 7}", f"2026-01-{1 + i % 28:02d}", float(i)) for i in range(n)])


def test_yields_plain_tuples_in_query_order_with_translated_binds(pg_conn):
    _table(pg_conn)
    rows = list(iter_rows(pg_conn, "SELECT symbol, v FROM ir WHERE v >= ? ORDER BY v", (200,),
                          batch_size=16))
    assert rows == [(f"S{i % 7}", float(i)) for i in range(200, 250)]
    assert all(type(r) is tuple for r in rows)


def test_reads_the_callers_uncommitted_writes(pg_conn):
    _table(pg_conn, n=10)   # never committed
    assert len(list(iter_rows(pg_conn, "SELECT * FROM ir"))) == 10


def test_connection_stays_usable_after_a_partial_read(pg_conn):
    _table(pg_conn)
    for _ in iter_rows(pg_conn, "SELECT * FROM ir", batch_size=10):
        break
    pg_conn.execute("INSERT INTO ir VALUES ('X', '2026-02-01', 1)")
    pg_conn.commit()
    assert pg_conn.execute("SELECT count(*) FROM ir").fetchone()[0] == 251


def test_an_error_while_streaming_leaves_the_connection_usable(pg_conn):
    # With a server-side cursor the statement fails at FETCH time (row N), not at execute --
    # outside a guard that only wraps execute, the aborted transaction would poison every later
    # statement on this connection.
    _table(pg_conn, n=300)
    pg_conn.commit()
    import pytest
    with pytest.raises(Exception):
        # No ORDER BY: a sort would evaluate every row before the first fetch (inside execute);
        # heap order reaches v=200 on a LATER fetch, mid-iteration.
        list(iter_rows(pg_conn, "SELECT 1 / (v - 200) FROM ir", batch_size=10))
    assert pg_conn.execute("SELECT count(*) FROM ir").fetchone()[0] == 300


def test_empty_result(pg_conn):
    _table(pg_conn, n=0)
    assert list(iter_rows(pg_conn, "SELECT * FROM ir")) == []
