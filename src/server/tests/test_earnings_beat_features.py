"""Regression tests for Finding #60 (2026-07-28 full-stack audit): compute_beat_features()
treated a row "known" as soon as quarter_date (the FISCAL PERIOD-END date) had passed,
not when the market actually learned the result. SEBI LODR Reg 33 gives issuers up to 45
days (quarterly) / 60 days (annual) after period-end to file -- so any as_of date between
period-end and the true announcement leaked a not-yet-public beat/miss into
technical_signals. Fixed by requiring quarter_date + a per-period-type publication lag
(PERIOD_LAG_DAYS) to have already passed before a row counts as knowable.
"""
import os
import sys
import sqlite3

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import earnings_beat_features as ebf


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _FakeConn:
    """Mimics the SQLAlchemy `conn.execute(text(sql), params).fetchall()` surface just
    enough to unit-test compute_beat_features() without a real DB -- filters the raw
    fixture rows the same way the real `WHERE quarter_date <= :as_of` prefilter does, so
    the test exercises the exact same two-stage (SQL prefilter + Python knowable-by
    filter) shape as production."""

    def __init__(self, rows):
        self._rows = rows

    def execute(self, stmt, params):
        as_of = params["as_of"]
        filtered = [r for r in self._rows if r[1] <= as_of]
        filtered.sort(key=lambda r: (r[0], r[1]), reverse=True)
        return _FakeResult(filtered)


def _row(symbol, quarter_date, period_type, beat_score, surprise_pct=None,
         eps_avg=None, eps_high=None, eps_low=None):
    return (symbol, quarter_date, period_type, beat_score, surprise_pct, eps_avg, eps_high, eps_low)


class TestPublicationLagGuard:
    def test_quarterly_row_not_knowable_before_lag_elapses(self):
        """A quarter ending 2026-06-30 must not count as known 20 days later --
        well inside the 45-day statutory filing window."""
        conn = _FakeConn([_row("TCS", "2026-06-30", "quarterly", 1)])
        result = ebf.compute_beat_features(conn, as_of="2026-07-20")
        assert result == [], "quarterly result must not leak before its publication lag elapses"

    def test_quarterly_row_knowable_after_lag_elapses(self):
        conn = _FakeConn([_row("TCS", "2026-06-30", "quarterly", 1)])
        result = ebf.compute_beat_features(conn, as_of="2026-08-30")  # +61 days
        assert len(result) == 1
        assert result[0]["symbol"] == "TCS"

    def test_annual_row_not_knowable_before_lag_elapses(self):
        """A fiscal year ending 2026-03-31 must not count as known 55 days later --
        inside the 60-day statutory annual filing window."""
        conn = _FakeConn([_row("TCS", "2026-03-31", "annual", 1, surprise_pct=2.5,
                                eps_avg=10.0, eps_high=11.0, eps_low=9.0)])
        result = ebf.compute_beat_features(conn, as_of="2026-05-25")
        assert result == [], "annual result must not leak before its publication lag elapses"

    def test_annual_row_knowable_after_lag_elapses(self):
        conn = _FakeConn([_row("TCS", "2026-03-31", "annual", 1, surprise_pct=2.5,
                                eps_avg=10.0, eps_high=11.0, eps_low=9.0)])
        result = ebf.compute_beat_features(conn, as_of="2026-07-01")  # +92 days
        assert len(result) == 1
        assert result[0]["eps_surprise_last_yr"] == 2.5

    def test_mixed_periods_only_knowable_ones_count_toward_streak(self):
        """4 quarters exist but only 2 are old enough to be knowable as of `as_of` --
        the beat streak must be computed over the knowable subset only, not all 4."""
        conn = _FakeConn([
            _row("TCS", "2026-06-30", "quarterly", 1),   # too recent, filtered
            _row("TCS", "2026-03-31", "quarterly", 1),   # knowable
            _row("TCS", "2025-12-31", "quarterly", 1),   # knowable
            _row("TCS", "2025-09-30", "quarterly", -1),  # knowable
        ])
        result = ebf.compute_beat_features(conn, as_of="2026-06-15")
        assert len(result) == 1
        # most recent KNOWABLE quarter is 2026-03-31 (beat_score=1), not 2026-06-30
        assert result[0]["eps_beat_last_q"] == 1
        assert result[0]["eps_beat_streak_4q"] == 2  # 2026-03-31, 2025-12-31 both beats; 2025-09-30 breaks it

    def test_malformed_quarter_date_is_excluded_not_crashed_on(self):
        conn = _FakeConn([_row("TCS", "not-a-date", "quarterly", 1)])
        result = ebf.compute_beat_features(conn, as_of="2026-08-30")
        assert result == []

    def test_unknown_period_type_falls_back_to_the_longer_lag(self):
        """An unrecognized period_type must not default to the shorter (quarterly) lag --
        that would silently under-protect against look-ahead for a data shape this code
        doesn't yet know about."""
        assert ebf._knowable_by("2026-03-31", "unknown_type") == \
            ebf._knowable_by("2026-03-31", "annual")
