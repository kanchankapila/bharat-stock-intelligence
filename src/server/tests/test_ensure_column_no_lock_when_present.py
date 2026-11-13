"""A column that already exists must cost no ACCESS EXCLUSIVE lock (stock_ohlcv, 2026-11-12:
an `ALTER ... ADD COLUMN IF NOT EXISTS` queued 26 minutes with readers piled behind it).
Statement-recording fake: no database needed."""
import re
import sys
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import db_compat


class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _Conn:
    def __init__(self, column_present):
        self.column_present = column_present
        self.statements = []

    def execute(self, sql, params=()):
        self.statements.append(sql)
        if sql.lstrip().upper().startswith("SELECT"):
            assert params == ("stock_ohlcv", "adjustment_basis")
            return _Result((1,) if self.column_present else None)
        return _Result(None)

    def commit(self):
        pass

    def rollback(self):
        pass


def _alters(conn):
    return [s for s in conn.statements if s.lstrip().upper().startswith("ALTER")]


def test_existing_column_issues_no_alter_and_no_lock():
    conn = _Conn(column_present=True)
    assert db_compat.ensure_column(conn, "stock_ohlcv", "adjustment_basis", "TEXT") is False
    assert _alters(conn) == []
    assert not any("lock_timeout" in s for s in conn.statements)


def test_missing_column_is_added_with_a_lock_timeout_first():
    conn = _Conn(column_present=False)
    assert db_compat.ensure_column(conn, "stock_ohlcv", "adjustment_basis", "TEXT") is True
    kinds = [("lock" if "lock_timeout" in s else "alter" if s.upper().startswith("ALTER") else "select")
             for s in conn.statements]
    assert kinds == ["select", "lock", "alter"]


def test_both_stock_ohlcv_writers_route_through_the_helper():
    for name in ("backfill_ohlcv.py", "mc_ohlcv_backfill.py"):
        src = (SERVER_DIR / name).read_text(encoding="utf-8")
        assert "ensure_column(conn, \"stock_ohlcv\", \"adjustment_basis\"" in src, name
        assert not re.search(r"ALTER TABLE stock_ohlcv\s+ADD COLUMN", src), name
