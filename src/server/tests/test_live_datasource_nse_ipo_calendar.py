"""
Concrete live_datasource test for nse_ipo_calendar_fetcher.py -- new IPO calendar data
promoted 2026-07-30 via the `nse` (NseIndiaApi) package after evaluating it against
nsepython (less reliable live -- several functions have real bugs) and the stock-nse-india
npm package (ruled out: 29 dependencies including a bundled GraphQL/Express server and an
OpenAI SDK, wrong architectural fit for this Python-fetcher-writes/Node-tRPC-reads codebase).

No hardcoded stock -- the IPO calendar itself IS the real, live, well-known data (NSE's own
site), and this test's job is confirming the package's own parsing/session handling still
works, not resolving any per-stock id.
"""

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import nse_ipo_calendar_fetcher as ipo
from live_datasource_helpers import assert_looks_like_ticker, assert_non_empty_response


def _make_test_db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    ipo.ensure_schema(conn)
    return conn


@pytest.mark.live_datasource
class TestNseIpoCalendarLiveDataSource:
    def test_real_fetch_returns_real_tickers(self):
        by_phase = ipo.fetch_all()
        # "past" is a long-running historical log and is very unlikely to ever be empty;
        # "current"/"upcoming" can legitimately be empty on a day with no active IPO window,
        # so only assert non-empty on the one phase that's structurally always populated.
        assert_non_empty_response(by_phase.get("past"), "nse_ipo fetch_all()['past']")

        for phase, records in by_phase.items():
            for record in records[:5]:
                symbol = record.get("symbol")
                assert symbol, f"{phase} record missing symbol: {record}"
                assert_looks_like_ticker(symbol, f"nse_ipo {phase}")

    def test_real_fetch_stores_ml_usable_rows(self):
        by_phase = ipo.fetch_all()
        conn = _make_test_db()
        # save() writes through the module-level db_compat connection (the real project DB) --
        # exercise the exact same normalize+insert path against a throwaway DB instead, so
        # this test doesn't depend on (or mutate) the real project database.
        rows = []
        for phase, records in by_phase.items():
            for record in records:
                row = ipo._normalize(record, phase)
                if row:
                    rows.append(row)
        assert rows, "expected at least one normalizable IPO row"
        # save()'s real ON CONFLICT (symbol, phase) DO UPDATE, copied rather than approximated --
        # NSE's own listPastIPO() live-verified 2026-07-30 to occasionally return the exact
        # same symbol twice in one response (CUBEINVIT/BAGMANE, byte-identical rows both
        # times), so a plain INSERT here would be stricter than production and fail on data
        # production's real upsert handles fine.
        #
        # This was `INSERT OR REPLACE` until 2026-08-17. That is SQLite-only, and translate()
        # rejects it by design (no single conflict target can be inferred), so once the fixture
        # moved from sqlite3.connect(':memory:') onto Postgres this raised. It survived the
        # conversion's own verification because the file is live_datasource-gated and therefore
        # never ran -- the gate that keeps third-party outages out of CI also keeps converted
        # code from being executed. Found only by running the live suite by hand.
        conn.executemany("""
            INSERT INTO nse_ipo_calendar
                (symbol, phase, company_name, issue_start_date, issue_end_date, price_range,
                 issue_size, series, status, subscription_times, listing_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (symbol, phase) DO UPDATE SET
                company_name=excluded.company_name, issue_start_date=excluded.issue_start_date,
                issue_end_date=excluded.issue_end_date, price_range=excluded.price_range,
                issue_size=excluded.issue_size, series=excluded.series, status=excluded.status,
                subscription_times=excluded.subscription_times, listing_date=excluded.listing_date
        """, rows)
        conn.commit()

        stored = conn.execute("SELECT * FROM nse_ipo_calendar").fetchall()
        distinct_keys = {(r[0], r[1]) for r in rows}  # (symbol, phase)
        assert len(stored) == len(distinct_keys)
        for row in stored[:10]:
            assert_looks_like_ticker(row["symbol"], "nse_ipo_calendar.symbol")
            assert row["company_name"], "expected a real company name, not empty"
