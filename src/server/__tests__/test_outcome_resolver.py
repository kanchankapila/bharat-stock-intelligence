"""
Tests for outcome_resolver.py
"""
import datetime


def test_resolve_outcomes_uses_horizon_not_30_days(monkeypatch):
    """Cutoff must be today - horizon_days, not today - 30 days."""
    captured = {}

    class FakeConn:
        def execute(self, sql, params=()):
            # Capture the first execute call's params (the cutoff parameter)
            if 'cutoff' not in captured and params:
                captured['cutoff'] = params[0] if params else None
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
