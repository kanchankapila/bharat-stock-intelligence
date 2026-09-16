"""
Tests for finstack_cashflow_fetcher.py — the FinStack-MCP quarterly cash-flow ingest.

Pure-function tests (parse_quarterly_cashflow) need no DB or network. The DB test pins
weekly-cadence idempotency against real Postgres via pg_conn (auto-skips unreachable).
The MCP client itself is exercised live in scratch probes, not here — this suite must
stay hermetic per CLAUDE.md's unit-lane rules.
"""

import importlib
import json
import os
import sys
import uuid

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import finstack_cashflow_fetcher as fcf


def _envelope(periods: list[dict], currency: str = "INR") -> dict:
    return {"symbol": "TEST", "type": "quarterly", "periods": len(periods),
            "currency": currency, "data": periods, "timestamp": "2026-09-01T00:00:00"}


class TestParseQuarterlyCashflow:
    def test_maps_core_lines_and_periods(self):
        env = _envelope([
            {"period": "2026-06-30", "operating_cash_flow": 1036000000.123,
             "investing_cash_flow": 158000000.0, "financing_cash_flow": -1258000000.0,
             "capital_expenditure": -81000000.0, "free_cash_flow": 955000000.0,
             "depreciation_amortization": 99999.0},
        ])
        rows = fcf.parse_quarterly_cashflow(env)
        assert len(rows) == 1
        r = rows[0]
        assert r["period_end"] == "2026-06-30"
        assert r["ocf"] == 1036000000.12          # rounded to 2dp
        assert r["cfi"] == 158000000.0
        assert r["cff"] == -1258000000.0
        assert r["capex"] == -81000000.0
        assert r["fcf"] == 955000000.0
        assert r["currency"] == "INR"

    def test_error_envelope_yields_no_rows(self):
        assert fcf.parse_quarterly_cashflow({"error": True, "message": "No cash flow data"}) == []

    def test_none_and_garbage_yield_no_rows(self):
        assert fcf.parse_quarterly_cashflow(None) == []
        assert fcf.parse_quarterly_cashflow([]) == []
        assert fcf.parse_quarterly_cashflow("junk") == []

    def test_periods_missing_period_or_all_null_are_dropped(self):
        env = _envelope([
            {"operating_cash_flow": 1.0},                      # no period
            {"period": "2026-03-31"},                          # all figures null
            {"period": "2025-12-31", "operating_cash_flow": None,
             "investing_cash_flow": -5.0},                     # kept: one figure
        ])
        rows = fcf.parse_quarterly_cashflow(env)
        assert [r["period_end"] for r in rows] == ["2025-12-31"]
        assert rows[0]["cfi"] == -5.0
        assert rows[0]["ocf"] is None

    def test_currency_is_carried_per_row(self):
        rows = fcf.parse_quarterly_cashflow(_envelope(
            [{"period": "2026-06-30", "free_cash_flow": 955.0}], currency="USD"))
        assert rows[0]["currency"] == "USD"


class TestUpsertQuarterlyCashflow:
    def test_upsert_is_idempotent_and_refreshes(self, pg_conn):
        fcf.ensure_schema(pg_conn)
        pg_conn.execute("DELETE FROM finstack_cashflow_history")
        pg_conn.commit()

        rows = fcf.parse_quarterly_cashflow(_envelope([
            {"period": "2026-06-30", "operating_cash_flow": 1036.0, "free_cash_flow": 955.0},
            {"period": "2026-03-31", "operating_cash_flow": 937.0, "free_cash_flow": 833.0},
        ]))
        fcf.upsert_cashflow("INFY", rows, pg_conn)
        fcf.upsert_cashflow("INFY", rows, pg_conn)  # second weekly run: no duplicates

        cur = pg_conn.execute(
            "SELECT period_end, ocf, fcf, currency FROM finstack_cashflow_history "
            "WHERE symbol = 'INFY' ORDER BY period_end DESC")
        assert cur.fetchall() == [
            ("2026-06-30", 1036.0, 955.0, "INR"),
            ("2026-03-31", 937.0, 833.0, "INR"),
        ]

        # restatement: same PK, new figures -> refreshed in place
        rows[0]["ocf"] = 1100.0
        fcf.upsert_cashflow("INFY", rows, pg_conn)
        cur = pg_conn.execute(
            "SELECT ocf FROM finstack_cashflow_history WHERE symbol='INFY' AND period_end='2026-06-30'")
        assert cur.fetchall() == [(1100.0,)]

    def test_empty_rows_is_a_noop(self, pg_conn):
        fcf.upsert_cashflow("INFY", [], pg_conn)  # must not raise


# -- run() channel resilience (2026-09-02 hardening) ------------------------------

class _StubClient:
    """Stands in for McpStdioClient: BAD symbols raise McpError (wedged channel).

    Matches on the `.NS`-suffixed Yahoo ticker the fetcher actually sends, not the bare NSE
    symbol -- finstack wraps yfinance and a bare symbol resolves to a US-listed company
    (AF-20260912-01). A stub that matched the bare symbol silently stopped simulating the
    wedged channel once yahoo_ticker() landed, and the test failed with `assert 2 == 1`.
    Asserting the real argument here is what keeps this stub honest."""

    instances: list["_StubClient"] = []
    closed: list["_StubClient"] = []

    def __init__(self, cmd=None, call_timeout=120.0):
        self.calls = 0
        _StubClient.instances.append(self)

    def call_tool(self, name, arguments=None):
        self.calls += 1
        requested = (arguments or {}).get("symbol")
        assert requested and requested.endswith(".NS"), (
            f"fetcher asked finstack for {requested!r}; Yahoo identifies an NSE listing as "
            f"'<symbol>.NS' and a bare symbol resolves to a different, US-listed company"
        )
        if requested == "BAD.NS":
            raise fcf.McpError("timed out after 120s waiting for response id=2")
        return json.dumps(_envelope(
            [{"period": "2026-06-30", "operating_cash_flow": 10.0}]))

    def close(self):
        if self not in _StubClient.closed:  # real close() is idempotent; mirror that
            _StubClient.closed.append(self)


class _FakeCon:
    """In-memory stand-in for db_compat.connect().

    Routes the SQL shapes run() actually issues: upsert executemany, the checked-marker
    SELECT (returns `checked_rows`), and the checked-marker INSERT/UPSERT (recorded in
    `executed_sql` so tests can assert WHICH symbols were marked)."""

    def __init__(self, checked_rows: list | None = None):
        self.executed: list = []
        self.executed_sql: list[tuple[str, tuple]] = []
        self.checked_rows = checked_rows or []
        self._last_rows: list = []

    def cursor(self):
        con = self

        class _Cur:
            def execute(self, sql, params=()):
                con.executed_sql.append((" ".join(sql.split()), tuple(params)))
                con._last_rows = (con.checked_rows
                                  if "FROM finstack_cashflow_checked" in sql else [])

            def fetchall(self):
                return con._last_rows

            def executemany(self, sql, rows):
                con.executed.extend(rows)

        return _Cur()

    def commit(self):
        pass

    def marker_marks(self) -> list[tuple]:
        return [params for sql, params in self.executed_sql
                if "INTO finstack_cashflow_checked" in sql]


class TestRunResilience:
    def _patch(self, monkeypatch, universe, client_cls=_StubClient, checked_rows=None):
        _StubClient.instances.clear()
        _StubClient.closed.clear()
        # AF-20260912-14: the pool-wide throttle governor is neutralized (0s cooldowns) so
        # a throttle-path test cannot spend real seconds sleeping; the count-based abort
        # threshold is untouched. Bound the REAL class first — the patched name cannot call
        # itself (it would recurse into this lambda).
        _real_governor = fcf.ThrottleGovernor
        monkeypatch.setattr(fcf, "ThrottleGovernor",
                            lambda: _real_governor(base=0.0, cap=0.0, budget=1e12))
        # ET fallback calls the REAL ET_Stats endpoint via financial_ratios_fetcher — the
        # run() calls below pass et_fallback=False to stay hermetic; the fallback's own
        # wiring is covered in TestEtFallbackWiring.
        monkeypatch.setattr(fcf, "McpStdioClient", client_cls)
        monkeypatch.setattr(fcf, "load_universe", lambda symbols, limit: universe)
        # Row-shaped marker rows — cursor.fetchall() must yield indexable rows, exactly
        # like the real driver, or r[0] silently indexes a string's first character.
        self.con = _FakeCon([("FRESH",) if r == "FRESH" else (r,) for r in (checked_rows or [])])
        monkeypatch.setattr(fcf, "connect", lambda: self.con)
        monkeypatch.setattr(fcf, "ensure_schema", lambda con: None)

    def test_recycles_bad_channel_skips_symbol_and_never_leaks(self, monkeypatch):
        self._patch(monkeypatch, ["GOOD", "BAD"])
        written = fcf.run(et_fallback=False)                    # GOOD persisted, BAD skipped
        assert written == 1
        assert len(_StubClient.instances) == 7                 # 6 workers + 1 recycle
        assert len(_StubClient.closed) == 7                    # every channel closed once
        assert set(_StubClient.closed) == set(_StubClient.instances)

    def test_unexpected_pool_error_still_closes_all_channels(self, monkeypatch):
        class _Boom(_StubClient):
            def call_tool(self, name, arguments=None):
                raise RuntimeError("simulated bug")

        self._patch(monkeypatch, ["GOOD", "BAD"], client_cls=_Boom)
        with pytest.raises(RuntimeError, match="simulated bug"):
            fcf.run(et_fallback=False)
        assert len(_Boom.instances) == 6                       # died before any recycle
        assert set(_Boom.closed) == set(_Boom.instances)       # zero-leak finally ran


class TestRotationWindow:
    def test_advances_by_cap_per_day(self):
        universe = [f"S{i:02d}" for i in range(10)]
        day0 = fcf.rotation_window(universe, 4, 0)
        day1 = fcf.rotation_window(universe, 4, 1)
        assert day0 == ["S00", "S01", "S02", "S03"]
        assert day1 == ["S04", "S05", "S06", "S07"]

    def test_consecutive_days_tile_the_whole_universe(self):
        universe = [f"S{i:02d}" for i in range(10)]
        seen: set[str] = set()
        for day in range(3):
            seen.update(fcf.rotation_window(universe, 4, day))
        assert seen == set(universe)

    def test_zero_cap_or_ge_len_takes_everything(self):
        universe = ["A", "B", "C"]
        assert fcf.rotation_window(universe, 0, 7) == universe
        assert fcf.rotation_window(universe, 5, 7) == universe

    def test_same_day_is_deterministic(self):
        universe = [f"S{i:02d}" for i in range(10)]
        assert fcf.rotation_window(universe, 4, 123) == fcf.rotation_window(universe, 4, 123)


class TestShouldExitNonzero:
    """The verdict rule: a throttled run that wrote ANYTHING (Yahoo or ET) exits 0;
    a throttled run that wrote NOTHING anywhere exits 1 (a true outage)."""

    def test_throttled_with_zero_progress_is_a_failure(self):
        assert fcf.should_exit_nonzero({"rate_limited": 25, "written": 0, "et_rows": 0})

    def test_throttled_with_yahoo_progress_is_not(self):
        assert not fcf.should_exit_nonzero({"rate_limited": 10, "written": 3, "et_rows": 0})

    def test_throttled_with_only_et_progress_is_not(self):
        assert not fcf.should_exit_nonzero({"rate_limited": 25, "written": 0, "et_rows": 100})

    def test_clean_run_is_never_a_failure(self):
        assert not fcf.should_exit_nonzero({"rate_limited": 0, "written": 0, "et_rows": 0})


class TestThrottleGovernor:
    def test_cooldown_escalates_and_is_capped(self):
        g = fcf.ThrottleGovernor(base=10, cap=20, budget=1e12)
        assert g.on_throttle() == 10
        assert g.on_throttle() == 30
        assert g.on_throttle() == 50        # capped at 20, not 40
        assert not g.budget_exhausted()

    def test_budget_exhaustion_gives_up(self):
        g = fcf.ThrottleGovernor(base=10, cap=10, budget=35)
        for _ in range(4):
            g.on_throttle()
        assert g.budget_exhausted()

    def test_wait_is_a_noop_without_throttles(self):
        fcf.ThrottleGovernor().wait()       # must return immediately: _next_allowed stays 0


class TestStalenessSkip(TestRunResilience):
    """Inherits TestRunResilience._patch (governor neutralized, hermetic con/stubs)."""

    def test_broken_marker_degrades_to_fetching_everything(self):
        class _BrokenConn:
            def cursor(self):
                raise RuntimeError("connection is gone")

        assert fcf.load_recently_checked(_BrokenConn()) == set()

    def test_run_skips_symbols_answered_within_window(self, monkeypatch):
        self._patch(monkeypatch, ["FRESH", "STALE"], checked_rows=["FRESH"])
        assert fcf.run(et_fallback=False) == 1   # only STALE attempted; it answered with data
        assert sum(c.calls for c in _StubClient.instances) == 1

    def test_all_fresh_is_a_zero_work_success(self, monkeypatch):
        self._patch(monkeypatch, ["A", "B"], checked_rows=["A", "B"])
        assert fcf.run(et_fallback=False) == 0
        assert _StubClient.instances == []       # not even one MCP server was spawned

    def test_throttled_symbols_are_never_marked_checked(self, monkeypatch):
        self._patch(monkeypatch, ["T1", "T2", "T3"], client_cls=_ThrottlingClient)
        assert fcf.run(et_fallback=False) == 0
        assert self.con.marker_marks() == []     # a throttle is not an answer

    def test_abort_skipped_symbols_are_never_marked_checked(self, monkeypatch):
        """The sibling of the throttle case above, and NOT covered by it.

        A symbol reached after `abort` is set returns outcome 'aborted' WITHOUT ever being
        sent to the vendor. Marking it 'empty' would assert "the vendor has no data" about a
        symbol nobody asked, and STALENESS_DAYS would then hide it for 90 days -- the
        silent-permanent-data-loss shape recurring-bugs.md records for negative caches.
        The throttle test cannot reach this branch: it uses 3 symbols against
        RATE_LIMIT_ABORT_THRESHOLD=25, so `abort` never fires there. Verified by injection
        (appending 'aborted' symbols to `answered` leaves that test green and fails only
        this one).
        """
        monkeypatch.setattr(fcf, "RATE_LIMIT_ABORT_THRESHOLD", 2)
        self._patch(monkeypatch, ["T1", "T2", "T3", "T4"], client_cls=_ThrottlingClient)
        # workers=1 makes the throttle-then-abort ordering deterministic.
        assert fcf.run(workers=1, et_fallback=False) == 0
        assert self.con.marker_marks() == []     # never-asked is not an answer either

    def test_ok_and_empty_symbols_are_marked_with_their_verdict(self, monkeypatch):
        class _HalfEmpty(_StubClient):
            def call_tool(self, name, arguments=None):
                self.calls += 1
                requested = (arguments or {}).get("symbol")
                if requested == "NODATA.NS":
                    return json.dumps({"error": True, "message": "No cash flow data"})
                return json.dumps(_envelope(
                    [{"period": "2026-06-30", "operating_cash_flow": 10.0}]))

        self._patch(monkeypatch, ["WITHDATA", "NODATA"], client_cls=_HalfEmpty)
        fcf.run(et_fallback=False)
        marks = dict((p[0], p[1]) for p in self.con.marker_marks())
        assert marks == {"WITHDATA": "ok", "NODATA": "empty"}


class TestEtFallbackWiring(TestRunResilience):
    """Inherits TestRunResilience._patch (governor neutralized, hermetic con/stubs)."""

    def test_run_invokes_the_fallback_with_this_runs_batch(self, monkeypatch):
        self._patch(monkeypatch, ["A", "B"])
        calls: list[list[str]] = []
        monkeypatch.setattr(fcf, "et_fallback_fetch",
                            lambda syms, con, stats: calls.append(list(syms)) or 0)
        fcf.run(et_fallback=True)
        assert calls == [["A", "B"]]

    def test_a_dead_fallback_cannot_fail_a_productive_yahoo_pass(self, monkeypatch):
        self._patch(monkeypatch, ["GOOD", "BAD"])

        def _boom(syms, con, stats):
            raise RuntimeError("ET down")

        monkeypatch.setattr(fcf, "et_fallback_fetch", _boom)
        assert fcf.run(et_fallback=True) == 1   # GOOD still persisted, run still succeeds


# -- AF-20260912-14: incremental crawl (staleness skip / rotated batch / verdict rule) ----

class _ThrottlingClient(_StubClient):
    """Every call is refused with the verbatim Yahoo throttle envelope."""

    def call_tool(self, name, arguments=None):
        self.calls += 1
        raise fcf.RateLimited("Too Many Requests. Rate limited. Try after a while.")
