"""
Regression test for backfill_working_capital_signals.py's point-in-time correctness.

The original version did `UPDATE technical_signals SET ... WHERE symbol = %s` with no date
filter, smearing the LATEST fiscal year's ccc_ttm/ccc_trend/receivables_days_ttm across a
symbol's entire technical_signals history -- confirmed live 2026-09-01: RELIANCE carried the
identical ccc_ttm=-21.65 on every date from 2026-05-25 through 2026-08-31. Fixed as an as-of
join: a technical_signals row only ever sees the fiscal year knowable as of its own date
(fiscal_year_end + PUBLICATION_LAG_DAYS).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from pg_test_support import pg_memory_conn
import backfill_working_capital_signals as wc


def _seed(conn):
    # date is native DATE in production (post the 2026-08-25 TEXT->DATE migration) -- match
    # that shape here rather than TEXT, or the script's own coverage-report SELECT (which
    # correctly assumes DATE, matching prod) fails only in this throwaway fixture.
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date DATE,
            receivables_days_ttm DOUBLE PRECISION, ccc_ttm DOUBLE PRECISION,
            ccc_trend DOUBLE PRECISION, wc_deteriorating INTEGER DEFAULT 0,
            wc_improving INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE working_capital_history (
            symbol TEXT, fiscal_year TEXT, receivables_days DOUBLE PRECISION,
            ccc DOUBLE PRECISION
        )
    """)
    # RELIANCE: 3 fiscal years, CCC deteriorating (increasing) over time.
    conn.execute("""
        INSERT INTO working_capital_history (symbol, fiscal_year, receivables_days, ccc) VALUES
        ('RELIANCE', '2024-03-31', 9.94, -24.64),
        ('RELIANCE', '2025-03-31', 10.67, -14.69),
        ('RELIANCE', '2026-03-31', 11.47, -21.65)
    """)
    # technical_signals rows spanning before/between/after each fiscal year's knowable_at
    # (knowable_at = fiscal_year_end + 90d): FY24->2024-06-29, FY25->2025-06-29, FY26->2026-06-29.
    for d in ['2024-01-01', '2024-08-01', '2025-08-01', '2026-08-01']:
        conn.execute(
            "INSERT INTO technical_signals (symbol, date) VALUES (?, ?)", (('RELIANCE', d))
        )
    conn.commit()


class _NonClosingConn:
    """The script under test owns and closes its own connection when done -- but the test
    needs the pg_memory_conn fixture to stay open afterward to assert against. Forward
    everything except close()."""
    def __init__(self, real):
        self._real = real

    def __getattr__(self, name):
        return getattr(self._real, name)

    def close(self):
        pass


def _connect_stub(conn):
    return staticmethod(lambda *a, **k: _NonClosingConn(conn))


class TestAsOfCorrectness:
    def test_row_before_any_fiscal_year_is_knowable_stays_untouched(self, monkeypatch):
        conn = pg_memory_conn()
        monkeypatch.setattr(wc, "psycopg2", type("_M", (), {"connect": _connect_stub(conn)}))
        _seed(conn)
        wc.backfill_working_capital_signals()
        row = conn.execute(
            "SELECT ccc_ttm, ccc_trend FROM technical_signals WHERE date = '2024-01-01'"
        ).fetchone()
        assert row["ccc_ttm"] is None
        assert row["ccc_trend"] is None
        conn.close()

    def test_each_date_sees_only_the_fiscal_year_knowable_as_of_that_date(self, monkeypatch):
        conn = pg_memory_conn()
        monkeypatch.setattr(wc, "psycopg2", type("_M", (), {"connect": _connect_stub(conn)}))
        _seed(conn)
        wc.backfill_working_capital_signals()

        d2024 = conn.execute(
            "SELECT ccc_ttm, ccc_trend FROM technical_signals WHERE date = '2024-08-01'"
        ).fetchone()
        d2025 = conn.execute(
            "SELECT ccc_ttm, ccc_trend FROM technical_signals WHERE date = '2025-08-01'"
        ).fetchone()
        d2026 = conn.execute(
            "SELECT ccc_ttm, ccc_trend, wc_improving FROM technical_signals WHERE date = '2026-08-01'"
        ).fetchone()

        assert d2024["ccc_ttm"] == -24.64  # FY24 knowable by 2024-08-01, no prior year -> no trend
        assert d2024["ccc_trend"] is None
        assert d2025["ccc_ttm"] == -14.69  # FY25 knowable by 2025-08-01
        assert d2025["ccc_trend"] == pytest.approx(9.95)  # FY24(-24.64)->FY25(-14.69): CCC rose
        assert d2026["ccc_ttm"] == -21.65  # FY26 knowable by 2026-08-01
        # FY25(-14.69)->FY26(-21.65): CCC fell (more negative) by 6.96, past the -5.0 improving
        # threshold -- a falling CCC is favorable (faster cash conversion), so wc_improving, not
        # wc_deteriorating, per the script's own IMPROVING_THRESHOLD/DETERIORATING_THRESHOLD.
        assert d2026["wc_improving"] == 1

        # This is the exact live bug: dates must NOT all carry the identical latest-FY value.
        assert d2024["ccc_ttm"] != d2025["ccc_ttm"] != d2026["ccc_ttm"]
        conn.close()

    def test_clears_a_previously_corrupted_smear_before_reapplying(self, monkeypatch):
        conn = pg_memory_conn()
        monkeypatch.setattr(wc, "psycopg2", type("_M", (), {"connect": _connect_stub(conn)}))
        _seed(conn)
        # Simulate the live corruption: every row smeared with the latest fiscal year's value.
        conn.execute("UPDATE technical_signals SET ccc_ttm = -21.65, ccc_trend = -6.96")
        conn.commit()

        wc.backfill_working_capital_signals()

        d2024 = conn.execute(
            "SELECT ccc_ttm FROM technical_signals WHERE date = '2024-08-01'"
        ).fetchone()
        assert d2024["ccc_ttm"] == -24.64, (
            "a pre-existing smeared value must be cleared and recomputed as-of, not left as-is"
        )
        conn.close()
