"""
Regression tests for bse_event_classifier.run_daily()'s write-target date (2026-08-01).

Context: run_daily() already had a `date = ?` guard (added 2026-07-19) specifically to avoid
overwriting a stale historical row -- but it anchored that guard to a raw datetime.now(),
which silently writes into a calendar day with no technical_signals grid row whenever
ml-daily-ops's step chain crosses midnight IST (confirmed happening live via job_heartbeat).
Same fix as insider_features.py: anchor to as_of.logical_trading_date() instead.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402

import bse_event_classifier as bec


def _make_conn():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE nse_stocks (symbol TEXT)")
    conn.execute("""
        CREATE TABLE news_articles (
            title TEXT, summary TEXT, symbols TEXT, timestamp TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, event_signal_score REAL, event_type_flags TEXT,
            PRIMARY KEY (symbol, date)
        )
    """)
    conn.execute("INSERT INTO nse_stocks VALUES ('RELIANCE')")
    conn.execute(
        "INSERT INTO news_articles (title, summary, symbols, timestamp) VALUES (?,?,?,?)",
        ("RELIANCE order win announced today", "", "RELIANCE", "2026-07-30T10:00:00"),
    )
    conn.commit()
    return conn


class TestRunDailyUsesLogicalTradingDate:
    def test_writes_into_the_row_matching_logical_trading_date(self, monkeypatch):
        conn = _make_conn()
        # The grid row that already exists is for 2026-07-31 (yesterday relative to a
        # post-midnight run), NOT 2026-08-01 -- the exact scenario that broke silently.
        conn.execute(
            "INSERT INTO technical_signals (symbol, date, event_signal_score) VALUES (?,?,NULL)",
            ("RELIANCE", "2026-07-31"),
        )
        conn.commit()

        monkeypatch.setattr(bec, 'logical_trading_date', lambda: '2026-07-31')

        bec.run_daily(conn)

        row = conn.execute(
            "SELECT event_signal_score, event_type_flags FROM technical_signals "
            "WHERE symbol='RELIANCE' AND date='2026-07-31'"
        ).fetchone()
        assert row['event_signal_score'] is not None
        assert row['event_signal_score'] > 0  # ORDER_WIN is a positive event
        assert 'ORDER_WIN' in row['event_type_flags']

    def test_wrong_calendar_date_matches_nothing_silently(self, monkeypatch):
        """Negative control: proves the original failure mode. If run_daily anchored to a
        raw wall-clock date that has no grid row yet, the UPDATE matches 0 rows -- no error,
        no write, and the caller (ml-daily-ops) sees the step as a plain success."""
        conn = _make_conn()
        conn.execute(
            "INSERT INTO technical_signals (symbol, date, event_signal_score) VALUES (?,?,NULL)",
            ("RELIANCE", "2026-07-31"),
        )
        conn.commit()

        # Simulates the pre-fix bug: "today" resolves to a day with no grid row.
        monkeypatch.setattr(bec, 'logical_trading_date', lambda: '2026-08-01')

        bec.run_daily(conn)

        row = conn.execute(
            "SELECT event_signal_score FROM technical_signals "
            "WHERE symbol='RELIANCE' AND date='2026-07-31'"
        ).fetchone()
        assert row['event_signal_score'] is None, (
            "documents the silent-miss failure mode: the enrichment is dropped, not errored"
        )
