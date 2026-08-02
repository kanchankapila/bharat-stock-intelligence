"""
Regression tests for mc_earnings_fetcher.py's write-target date (2026-08-01).

Four functions in this file (_backfill_days_to_results, _backfill_rapid_features,
_backfill_shockers, fetch_actual_estimate_beats) each carried a `date = ? guard (2026-07-19)
instead of MAX(date)` comment and a local `today = date.today().isoformat()` used as the exact
`UPDATE ... WHERE date = ?` write target. That guard silently writes into a calendar day with
no technical_signals grid row whenever ml-daily-ops's step chain crosses midnight IST (confirmed
happening live via job_heartbeat). All four must use as_of.logical_trading_date() instead (same
fix as insider_features.py/bse_event_classifier.py).

All tests force the SQLite branch (use_postgres() -> False) since it exercises the same `today`
variable with a simpler statement shape; the Postgres branch shares the identical `today` local.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_earnings_fetcher as mef


class _FakeCursor:
    def __init__(self, fetchall_results=None):
        self._fetchall_results = list(fetchall_results or [])
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self._fetchall_results.pop(0) if self._fetchall_results else []

    def fetchone(self):
        return None


class _FakeConn:
    def __init__(self, fetchall_results=None):
        self.cur = _FakeCursor(fetchall_results)
        self.committed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True


def _updates(conn):
    return [c for c in conn.cur.executed if "UPDATE technical_signals" in c[0]]


class TestBackfillDaysToResultsUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(mef, "use_postgres", lambda: False)
        conn = _FakeConn()

        mef._backfill_days_to_results(conn)

        updates = _updates(conn)
        assert len(updates) == 1
        _, params = updates[0]
        assert params == ("2026-07-31",)

    def test_wrong_calendar_date_would_match_nothing_silently(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-08-01")
        monkeypatch.setattr(mef, "use_postgres", lambda: False)
        conn = _FakeConn()

        mef._backfill_days_to_results(conn)

        _, params = _updates(conn)[0]
        assert params == ("2026-08-01",)  # would NOT match a 2026-07-31 grid row


class TestBackfillRapidFeaturesUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(mef, "use_postgres", lambda: False)
        conn = _FakeConn()

        mef._backfill_rapid_features(conn)

        updates = _updates(conn)
        # sqlite branch loops twice (yoy, qoq)
        assert len(updates) == 2
        for _, params in updates:
            assert params[-1] == "2026-07-31"


class TestBackfillShockersUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(mef, "use_postgres", lambda: False)
        conn = _FakeConn()

        mef._backfill_shockers(conn)

        updates = _updates(conn)
        assert len(updates) == 1
        _, params = updates[0]
        assert params == ("2026-07-31",)


class TestFetchActualEstimateBeatsUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(mef, "use_postgres", lambda: False)
        monkeypatch.setattr(mef.time, "sleep", lambda *_: None)
        # One well-known scid -> symbol mapping, and one matching "Beats" row per API call.
        conn = _FakeConn(fetchall_results=[[("RI", "RELIANCE")]])
        item = ["RI", "", "", "", "", "", "", "Beats Estimate", "5.2"]
        monkeypatch.setattr(mef, "_get", lambda url: {"list": [item]})

        mef.fetch_actual_estimate_beats(conn, max_pages=1)

        updates = _updates(conn)
        assert len(updates) == 1
        _, params = updates[0]
        # (lbl, pct, symbol, today)
        assert params[-2] == "RELIANCE"
        assert params[-1] == "2026-07-31", (
            "fetch_actual_estimate_beats() must write against logical_trading_date()'s "
            "value, not date.today()"
        )
