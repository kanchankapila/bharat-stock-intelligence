"""
Regression test for index_membership_fetcher.py's backfill_technical_signals().

Bug 1: the Postgres branch used raw psycopg2-style `%s` placeholders in the UPDATE
statement passed to cur.execute(). db_compat's ConnWrapper.execute() routes every
query through sql_translate.translate() before handing it to SQLAlchemy's psycopg2
driver — that pipeline expects `?` (SQLite-style) placeholders and converts them
per-dialect, same as every other query in this codebase. The raw `%s` bypassed
translation and psycopg2 threw `SyntaxError: syntax error at or near "%"` on every
single run (confirmed live in production logs, 2026-07-26). Same bug class already
fixed once before in asm_gsm_fetcher.py.

Bug 2 (found 2026-07-30, full-stack audit continuation): the `date >= ? ELSE NULL`
anchor used bare `datetime.now()` instead of the last completed trading session
(MAX(date) FROM stock_ohlcv). This job runs weekly on Sunday (nse-sync, a non-trading
day with no technical_signals row for "today"), so the anchor matched zero rows and
every historical is_nifty50/.../nifty_tier column was silently NULLed on every run —
the same recurring bug class already fixed in asm_gsm_fetcher.py, financial_ratios_fetcher.py,
and 7 other fetchers.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import index_membership_fetcher as imf


class _FakeCursor:
    def __init__(self, max_date=None):
        self.executed_sql = []
        self.rowcount = 0
        self._max_date = max_date

    def execute(self, sql, params=None):
        self.executed_sql.append(sql)
        return self

    def fetchone(self):
        if "MAX(date)" in self.executed_sql[-1]:
            return {"d": self._max_date}
        return None


class _FakeConn:
    def __init__(self, max_date=None):
        self.cur = _FakeCursor(max_date=max_date)
        self.committed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True


class TestBackfillTechnicalSignalsPlaceholders:
    def test_postgres_branch_uses_question_mark_placeholders(self, monkeypatch):
        monkeypatch.setattr(imf, "use_postgres", lambda: True)
        conn = _FakeConn(max_date="2026-07-24")
        imf.backfill_technical_signals(conn)
        sql = conn.cur.executed_sql[-1]
        assert "%s" not in sql, (
            "Postgres branch must use `?` placeholders (db_compat's translate() layer "
            "converts them per-dialect) — raw `%s` bypasses translation and crashes psycopg2"
        )
        assert sql.count("?") == 6

    def test_sqlite_branch_still_uses_question_mark_placeholders(self, monkeypatch):
        monkeypatch.setattr(imf, "use_postgres", lambda: False)
        conn = _FakeConn(max_date="2026-07-24")
        imf.backfill_technical_signals(conn)
        sql = conn.cur.executed_sql[-1]
        assert "%s" not in sql
        assert sql.count("?") == 6


class TestDateAnchorUsesLastTradingSession:
    def test_anchor_derived_from_max_ohlcv_date_not_wall_clock(self, monkeypatch):
        """The date >= ? guard must be anchored to MAX(date) FROM stock_ohlcv, not
        datetime.now() -- otherwise a Sunday/holiday run nulls all historical rows."""
        monkeypatch.setattr(imf, "use_postgres", lambda: True)
        conn = _FakeConn(max_date="2026-07-24")
        imf.backfill_technical_signals(conn)
        select_sql = conn.cur.executed_sql[0]
        assert "MAX(date)" in select_sql and "stock_ohlcv" in select_sql

    def test_falls_back_to_wall_clock_only_when_ohlcv_table_empty(self, monkeypatch):
        monkeypatch.setattr(imf, "use_postgres", lambda: True)
        conn = _FakeConn(max_date=None)
        # Should not raise even when stock_ohlcv has no rows yet.
        imf.backfill_technical_signals(conn)
        assert len(conn.cur.executed_sql) == 2
