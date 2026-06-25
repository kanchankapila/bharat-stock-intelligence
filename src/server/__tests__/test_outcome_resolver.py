"""
Tests for outcome_resolver.py
"""
import datetime


def test_resolve_outcomes_uses_horizon_not_30_days(monkeypatch):
    """Cutoff must be today - horizon_days, not today - 30 days.
    The NOT EXISTS subquery also receives horizon_days as the second param so
    each horizon-pass only deduplicates its own rows (starvation-bug fix)."""
    captured = {}

    class FakeConn:
        def execute(self, sql, params=()):
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

    expected = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
    assert captured['cutoff'] == expected, f"Expected cutoff={expected}, got {captured['cutoff']}"
    assert captured.get('horizon_days') == 5, f"Expected horizon_days param=5, got {captured.get('horizon_days')}"
