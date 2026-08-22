"""
Regression tests for mc_earnings_fetcher.py's write-target date (2026-08-01).

Four functions in this file (_backfill_days_to_results, _backfill_rapid_features,
_backfill_shockers, fetch_actual_estimate_beats) each carried a `date = ? guard (2026-07-19)
instead of MAX(date)` comment and a local `today = date.today().isoformat()` used as the exact
`UPDATE ... WHERE date = ?` write target. That guard silently writes into a calendar day with
no technical_signals grid row whenever ml-daily-ops's step chain crosses midnight IST (confirmed
happening live via job_heartbeat). All four must use as_of.logical_trading_date() instead (same
fix as insider_features.py/bse_event_classifier.py).

mc_earnings_fetcher.py's SQLite branches were removed 2026-08 (Phase 3 of the SQLite
decommission, see docs/SQLITE_DECOMMISSION_PLAN.md) -- these tests exercise the single
remaining Postgres-only code path directly, no use_postgres() monkeypatch needed.
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
        conn = _FakeConn()

        mef._backfill_days_to_results(conn)

        updates = _updates(conn)
        assert len(updates) == 1
        _, params = updates[0]
        assert params == ("2026-07-31", "2026-07-31", "2026-07-31")

    def test_wrong_calendar_date_would_match_nothing_silently(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-08-01")
        conn = _FakeConn()

        mef._backfill_days_to_results(conn)

        _, params = _updates(conn)[0]
        # would NOT match a 2026-07-31 grid row
        assert params == ("2026-08-01", "2026-08-01", "2026-08-01")

    def test_days_computation_anchored_to_logical_trading_date_not_wall_clock(self, monkeypatch):
        """2026-08-13 regression: the WRITE TARGET used logical_trading_date() but the DAYS
        CALCULATION itself still anchored to real wall-clock (julianday('now') / CURRENT_DATE)
        -- a different clock whenever the job crosses midnight IST. Live-confirmed on UNIECOM:
        days_to_next_results was correctly 2 on 2026-08-11 and NULL for all 2,190 symbols on
        2026-08-12, the exact morning its 2-day-out earnings date mattered. Negative control:
        reverting the fix (restoring 'now'/CURRENT_DATE) makes this fail."""
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        conn = _FakeConn()

        mef._backfill_days_to_results(conn)

        sql, params = _updates(conn)[0]
        assert "CURRENT_DATE" not in sql, "days computation must not anchor to Postgres's real CURRENT_DATE"
        assert params == ("2026-07-31", "2026-07-31", "2026-07-31"), (
            "both the days-until-results calculation and the result_date filter must use the "
            "same logical_trading_date() as the write target, not real wall-clock"
        )


class TestBackfillRapidFeaturesUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        conn = _FakeConn()

        mef._backfill_rapid_features(conn)

        updates = _updates(conn)
        assert len(updates) == 1
        for _, params in updates:
            assert params[-1] == "2026-07-31"


class TestBackfillShockersUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        conn = _FakeConn()

        mef._backfill_shockers(conn)

        updates = _updates(conn)
        assert len(updates) == 2
        for _, params in updates:
            assert params[-1] == "2026-07-31"


class TestFetchActualEstimateBeatsUsesLogicalTradingDate:
    def test_write_targets_logical_trading_date(self, monkeypatch):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(mef.time, "sleep", lambda *_: None)
        # One well-known scid -> symbol mapping, and one matching "Beats" row per API call.
        conn = _FakeConn(fetchall_results=[[("RI", "RELIANCE")]])
        item = ["RI", "", "", "", "", "", "", "Beats Estimate", "5.2"]
        monkeypatch.setattr(mef, "_get", lambda url: {"list": [item]})

        mef.fetch_actual_estimate_beats(conn, max_pages=1)

        updates = _updates(conn)
        assert len(updates) == 1
        _, params = updates[0]
        # Every value is bound now (symbol/label/pct + today), not inlined -- the date is the
        # LAST param, matching the trailing `ts.date = ?`.
        assert params[-1] == "2026-07-31", (
            "fetch_actual_estimate_beats() must write against logical_trading_date()'s "
            "value, not date.today()"
        )
        assert params == ("RELIANCE", 1, 5.2, "2026-07-31")


class TestFetchActualEstimateBeatsBindsValues:
    """The symbol/label/pct triples must be BOUND, never interpolated into the SQL text.

    Until 2026-08-22 this built `FROM (VALUES {})` with an f-string --
    `f"('{sym}', {lbl}, {pct})"` -- so a quote in nse_stocks.mcsymbol's mapped symbol would
    terminate the string literal and the rest would be parsed as SQL. That column is
    provider-derived and this repo has already shipped one where the values were not what the
    name promised (nse_stocks.tlid held raw tickers for 412 of 2,234 rows).
    """

    def _run(self, monkeypatch, symbol):
        monkeypatch.setattr(mef, "logical_trading_date", lambda: "2026-07-31")
        monkeypatch.setattr(mef.time, "sleep", lambda *_: None)
        conn = _FakeConn(fetchall_results=[[("RI", symbol)]])
        item = ["RI", "", "", "", "", "", "", "Beats Estimate", "5.2"]
        monkeypatch.setattr(mef, "_get", lambda url: {"list": [item]})
        mef.fetch_actual_estimate_beats(conn, max_pages=1)
        return _updates(conn)[0]

    def test_symbol_is_bound_not_interpolated(self, monkeypatch):
        sql, params = self._run(monkeypatch, "RELIANCE")
        assert "'RELIANCE'" not in sql, "symbol was interpolated into the SQL text"
        assert "RELIANCE" in params

    def test_quote_in_symbol_cannot_reach_the_sql_text(self, monkeypatch):
        # The classic payload. Pre-fix this landed verbatim in the statement; post-fix it is
        # inert data in the parameter tuple.
        evil = "X'); DROP TABLE technical_signals; --"
        sql, params = self._run(monkeypatch, evil)
        assert "DROP TABLE" not in sql, "injected SQL reached the statement text"
        assert evil in params, "the payload must survive intact as a bound value"

    def test_placeholder_count_matches_bound_values(self, monkeypatch):
        sql, params = self._run(monkeypatch, "RELIANCE")
        # 3 per row + 1 trailing date. A mismatch here is the bug that silently shifts
        # every value one column to the left.
        assert sql.count("?") == len(params) == 4
