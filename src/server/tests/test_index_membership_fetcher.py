"""
Regression test for index_membership_fetcher.py's backfill_technical_signals().

Bug: the Postgres branch used raw psycopg2-style `%s` placeholders in the UPDATE
statement passed to cur.execute(). db_compat's ConnWrapper.execute() routes every
query through sql_translate.translate() before handing it to SQLAlchemy's psycopg2
driver — that pipeline expects `?` (SQLite-style) placeholders and converts them
per-dialect, same as every other query in this codebase. The raw `%s` bypassed
translation and psycopg2 threw `SyntaxError: syntax error at or near "%"` on every
single run (confirmed live in production logs, 2026-07-26). Same bug class already
fixed once before in asm_gsm_fetcher.py.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import index_membership_fetcher as imf


class _FakeCursor:
    def __init__(self):
        self.executed_sql = []
        self.rowcount = 0

    def execute(self, sql, params=None):
        self.executed_sql.append(sql)


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()
        self.committed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True


class TestBackfillTechnicalSignalsPlaceholders:
    def test_postgres_branch_uses_question_mark_placeholders(self, monkeypatch):
        monkeypatch.setattr(imf, "use_postgres", lambda: True)
        conn = _FakeConn()
        imf.backfill_technical_signals(conn)
        sql = conn.cur.executed_sql[0]
        assert "%s" not in sql, (
            "Postgres branch must use `?` placeholders (db_compat's translate() layer "
            "converts them per-dialect) — raw `%s` bypasses translation and crashes psycopg2"
        )
        assert sql.count("?") == 6

    def test_sqlite_branch_still_uses_question_mark_placeholders(self, monkeypatch):
        monkeypatch.setattr(imf, "use_postgres", lambda: False)
        conn = _FakeConn()
        imf.backfill_technical_signals(conn)
        sql = conn.cur.executed_sql[0]
        assert "%s" not in sql
        assert sql.count("?") == 6
