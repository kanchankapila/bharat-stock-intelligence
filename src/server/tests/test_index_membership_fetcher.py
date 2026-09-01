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


# ── Bug 3 (found 2026-09-01, data/model audit): `ELSE NULL` on the date>=floor guard wipes
# EVERY historical row on EVERY run, not just rows that were never blessed. logical_write_floor()
# advances by one trading day each time the job runs (MAX(date) FROM stock_ohlcv), so on day N+1
# the guard's floor moves past day N's row -- and `ELSE NULL` re-nulls it, discarding the value
# day N's own run correctly set. Live-confirmed 2026-09-01: index-membership ran successfully
# every weekday for two weeks (job_run_history all 'success'), yet technical_signals showed only
# the single most-recent date populated (~100%) and every earlier date back to ~1.5% (residual
# noise, not real coverage) -- exactly this mechanism, not a scheduling gap. These tests need a
# real UPDATE evaluated against real rows (a mocked cursor can't tell "wiped" from "never set"),
# so they use pg_memory_conn(), not _FakeConn.
import sqlite3
from pg_test_support import pg_memory_conn  # noqa: E402


def _make_real_conn():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE stock_ohlcv (symbol TEXT, date TEXT)")
    conn.execute("""
        CREATE TABLE nse_stocks (
            symbol TEXT PRIMARY KEY, is_nifty50 INTEGER, is_nifty100 INTEGER,
            is_nifty200 INTEGER, is_midcap150 INTEGER, is_smallcap250 INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, is_nifty50 INTEGER, is_nifty100 INTEGER,
            is_nifty200 INTEGER, is_midcap150 INTEGER, is_smallcap250 INTEGER,
            nifty_tier INTEGER, PRIMARY KEY (symbol, date)
        )
    """)
    conn.execute("INSERT INTO nse_stocks VALUES ('RELIANCE', 1, 1, 1, 0, 0)")
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES ('RELIANCE', '2026-08-31')")
    conn.execute("INSERT INTO technical_signals (symbol, date) VALUES ('RELIANCE', '2026-09-01')")
    conn.commit()
    return conn


class TestBackfillPreservesPriorDaysBless:
    def test_a_later_run_does_not_null_out_an_earlier_days_correct_value(self, monkeypatch):
        monkeypatch.setattr(imf, "use_postgres", lambda: True)
        conn = _make_real_conn()

        # Day 1: only 08-31 exists in stock_ohlcv, so the floor is 08-31. That run correctly
        # blesses 08-31's row.
        conn.execute("INSERT INTO stock_ohlcv VALUES ('RELIANCE', '2026-08-31')")
        conn.commit()
        imf.backfill_technical_signals(conn)
        row = conn.execute(
            "SELECT is_nifty50 FROM technical_signals WHERE date = '2026-08-31'"
        ).fetchone()
        assert row["is_nifty50"] == 1, "sanity check: day 1's own run should bless its own row"

        # Day 2: 09-01 lands in stock_ohlcv, so the floor advances to 09-01. This run should
        # bless 09-01's row WITHOUT wiping 08-31's already-correct value back to NULL.
        conn.execute("INSERT INTO stock_ohlcv VALUES ('RELIANCE', '2026-09-01')")
        conn.commit()
        imf.backfill_technical_signals(conn)

        prior_day = conn.execute(
            "SELECT is_nifty50 FROM technical_signals WHERE date = '2026-08-31'"
        ).fetchone()
        today = conn.execute(
            "SELECT is_nifty50 FROM technical_signals WHERE date = '2026-09-01'"
        ).fetchone()
        assert today["is_nifty50"] == 1, "today's own run should still bless today's row"
        assert prior_day["is_nifty50"] == 1, (
            "a later run must not null out a value an earlier run already set correctly — "
            "this is the live bug: only the single most-recent date ever stays populated"
        )
