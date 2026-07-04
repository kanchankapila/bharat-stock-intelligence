import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_pricefeed_fetcher as mpf


class FakeCursor:
    def __init__(self):
        self.executed = []
    def execute(self, sql, params=None):
        self.executed.append((sql, params))
    def fetchall(self):
        return []


class FakeConn:
    def __init__(self):
        self.cur = FakeCursor()
    def cursor(self):
        return self.cur
    def commit(self):
        pass
    def rollback(self):
        pass


def test_append_pe_pb_history_writes_both_tables_when_both_present():
    con = FakeConn()
    mpf.append_pe_pb_history("INFY", "2026-07-04", 28.5, 6.2, con)

    tables_written = [sql for sql, _ in con.cur.executed if "INSERT INTO" in sql]
    assert any("trendlyne_pe_history" in sql for sql in tables_written)
    assert any("trendlyne_pb_history" in sql for sql in tables_written)


def test_append_pe_pb_history_skips_missing_values():
    con = FakeConn()
    mpf.append_pe_pb_history("INFY", "2026-07-04", None, 6.2, con)

    tables_written = [sql for sql, _ in con.cur.executed if "INSERT INTO" in sql]
    assert not any("trendlyne_pe_history" in sql for sql in tables_written)
    assert any("trendlyne_pb_history" in sql for sql in tables_written)
