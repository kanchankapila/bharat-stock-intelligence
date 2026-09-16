"""db_compat.executemany_batched: the same statement per row, sent page_size rows per round trip.

Plain executemany() through SQLAlchemy's default psycopg2 mode is one network round trip per
row. Measured 2026-09-11 on this DB: 14,000-row upsert 10.9s -> 1.7s and 14,000-row UPDATE
11.3s -> 1.7s when batched. The helper exists instead of an engine-wide
executemany_mode='values_plus_batch' because batching makes rowcount report only the LAST
statement (1 instead of 14,000 in the same measurement), and analyst_revision.py's
`n == 0` "matched nothing" guard plus 8 logged counts read that rowcount.
"""
import pytest

from db_compat import executemany_batched


def _table(conn):
    conn.execute("CREATE TABLE bt (symbol TEXT, d DATE, v DOUBLE PRECISION, note TEXT, "
                 "PRIMARY KEY (symbol, d))")
    conn.executemany("INSERT INTO bt (symbol, d, v) VALUES (?, ?, ?)",
                     [(f"S{i}", "2026-09-01", 0.0) for i in range(2500)])


def _count(conn, where):
    return conn.execute(f"SELECT count(*) FROM bt WHERE {where}").fetchone()[0]


def test_updates_every_row_across_pages(pg_conn):
    _table(pg_conn)
    executemany_batched(pg_conn, "UPDATE bt SET v = ? WHERE symbol = ? AND d = ?",
                        [(float(i), f"S{i}", "2026-09-01") for i in range(2500)], page_size=1000)
    pg_conn.commit()
    assert _count(pg_conn, "v = CAST(substr(symbol, 2) AS float8)") == 2500


def test_runs_inside_the_callers_transaction(pg_conn):
    _table(pg_conn)
    pg_conn.commit()
    executemany_batched(pg_conn, "UPDATE bt SET v = 7 WHERE symbol = ?", [("S1",), ("S2",)])
    pg_conn.rollback()
    assert _count(pg_conn, "v = 7") == 0


def test_commit_persists_when_nothing_ran_before_it(pg_conn, pg_schema):
    # SQLAlchemy only commits a transaction it knows it began. Writing through the raw DBAPI
    # cursor on an idle connection would make the caller's commit() a silent no-op. Only a
    # SECOND connection can tell: the writer's own reads see its uncommitted writes.
    _table(pg_conn)
    pg_conn.commit()
    executemany_batched(pg_conn, "UPDATE bt SET v = 9 WHERE symbol = ?", [("S3",), ("S4",)])
    pg_conn.commit()
    other, schema = pg_schema
    other.rollback()
    cur = other.cursor()
    cur.execute(f'SELECT count(*) FROM "{schema}".bt WHERE v = 9')
    assert cur.fetchone()[0] == 2


def test_literal_percent_and_casts_survive(pg_conn):
    _table(pg_conn)
    executemany_batched(pg_conn,
                        "UPDATE bt SET note = '5% up' || CAST(? AS text) "
                        "WHERE symbol = ? AND d = CAST(? AS date)",
                        [("!", "S5", "2026-09-01")])
    assert pg_conn.execute("SELECT note FROM bt WHERE symbol = 'S5'").fetchone()[0] == "5% up!"


def test_empty_input_is_a_no_op(pg_conn):
    _table(pg_conn)
    executemany_batched(pg_conn, "UPDATE bt SET v = 1 WHERE symbol = ?", [])
    assert _count(pg_conn, "v = 1") == 0


def test_a_failing_statement_leaves_the_connection_usable(pg_conn):
    _table(pg_conn)
    pg_conn.commit()
    with pytest.raises(Exception):
        executemany_batched(pg_conn, "UPDATE bt SET v = 1/0 WHERE symbol = ?", [("S1",)])
    assert _count(pg_conn, "v = 0") == 2500
