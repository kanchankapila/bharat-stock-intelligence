"""
Tests for outcome_resolver.py
"""
import datetime


def test_resolve_outcomes_uses_horizon_not_30_days(monkeypatch):
    """Cutoff is horizon-scoped, not 30 days: the day before the horizon_days-th newest session
    (AF-20260930-27/-30 -- anchored to the data, counted in sessions).
    The NOT EXISTS subquery also receives horizon_days as the second param so
    each horizon-pass only deduplicates its own rows (starvation-bug fix)."""
    captured = {}
    sessions = [datetime.date(2026, 9, d) for d in (30, 29, 28, 25, 24, 23)]  # newest first

    class FakeConn:
        def execute(self, sql, params=()):
            if 'SELECT DISTINCT date FROM stock_ohlcv' in sql:
                return type('R', (), {'fetchall': lambda s: [(d,) for d in sessions[:params[0]]]})()
            # Capture params from the first execute that has both cutoff and horizon_days
            if 'cutoff' not in captured and params and len(params) >= 2:
                captured['cutoff'] = params[0]
                captured['horizon_days'] = params[1]
            # Return a fake result object to avoid crashes on subsequent queries
            return type('R', (), {'fetchall': lambda s: [], 'fetchone': lambda s: None})()

        def cursor(self):
            return self

        def commit(self):
            pass

    from outcome_resolver import resolve_outcomes
    resolve_outcomes(FakeConn(), horizon_days=5, dry_run=True)

    expected = '2026-09-23'  # 5th newest session is 09-24 -> signals up to 09-23 have 5 sessions after
    assert captured['cutoff'] == expected, f"Expected cutoff={expected}, got {captured['cutoff']}"
    assert captured.get('horizon_days') == 5, f"Expected horizon_days param=5, got {captured.get('horizon_days')}"
