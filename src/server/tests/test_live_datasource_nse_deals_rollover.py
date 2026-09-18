"""Live-datasource tests for the two untested NSE-archive fetchers.

`delivery_trend_fetcher.py` (bulk/block deals from nseindia.com/api) and
`fno_rollover_fetcher.py` (F&O bhavcopy zip -> rollover % + cost of carry) were both flagged
by scripts/check_recurring_bugs.py on its first-ever run (2026-08-11).

Both accept a `con` parameter, so these use a real in-memory sqlite DB and write through the
fetcher's own upsert function — the full fetch -> own parser -> own writer -> read-back-and-
validate round trip CLAUDE.md's "Adding a New Data Source" rule requires.

NSE archives legitimately 404 on holidays and before publication, and both fetchers already
treat that as a non-error. These tests walk back over recent sessions and skip rather than
fail when nothing is published — a transient upstream gap must never look like a code defect.

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sqlite3
import sys
from datetime import date, timedelta

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

from live_datasource_helpers import (
    assert_looks_like_ticker,
    assert_non_empty_response,
    assert_numeric_and_finite,
)


@pytest.fixture
def mem_db():
    con = pg_memory_conn()
    con.row_factory = sqlite3.Row
    yield con
    con.close()


@pytest.mark.live_datasource
class TestDeliveryTrendDealsLiveDataSource:
    # AF-20260918-05: both tests below go through `fetch_bulk_rows()` -- the fetcher's OWN source
    # chain (NSE -> NSE historical -> MoneyControl). They used to probe the NSE routes by hand
    # and skip when those came back empty; both NSE bulk routes retired in 2026, so the tests
    # skipped on EVERY run as "holiday or blocked" while production quietly depended on the
    # MoneyControl fallback that nothing tested. A skip that always fires is a canary that can
    # never fire. They now fail, not skip, when every source is empty on a trading day.
    def test_real_bulk_deals_parse_into_ml_usable_rows(self):
        import delivery_trend_fetcher as dtf

        parsed = dtf.fetch_bulk_rows(dtf._nse_session())
        assert parsed, (
            "no bulk deals from NSE OR the MoneyControl fallback -- the bulk half of "
            "bulk_block_deals would get nothing today")
        for p in parsed[:25]:
            # The symbol must be a real ticker, not a company name or a scraped URL — the
            # exact failure mode of the 2026-07-23 corruption.
            assert_looks_like_ticker(p["symbol"], "bulk deal symbol")

    def test_real_deals_store_and_read_back_ml_usable(self, mem_db):
        import delivery_trend_fetcher as dtf

        parsed = dtf.fetch_bulk_rows(dtf._nse_session())[:25]
        assert parsed, "no bulk deals from any source -- nothing to store"

        dtf.ensure_schema(mem_db)
        dtf.upsert_deals(parsed, mem_db)

        # `upsert_deals` writes bulk_block_deals. This line used to read `block_deals` -- a
        # different table -- and it had never once executed, because the skip above it always
        # fired first. A test that has never run is not evidence the code under it works.
        rows = mem_db.execute(
            "SELECT * FROM bulk_block_deals WHERE symbol = ?", (parsed[0]["symbol"],)
        ).fetchall()
        assert rows, f"upsert_deals() wrote nothing readable back for {parsed[0]['symbol']}"
        stored = dict(rows[0])
        assert_looks_like_ticker(stored["symbol"], "stored bulk_block_deals.symbol")
        if stored.get("quantity") is not None:
            assert_numeric_and_finite(stored["quantity"], "bulk_block_deals.quantity")


@pytest.mark.live_datasource
class TestFnoRolloverLiveDataSource:
    def _recent_bhavcopy(self, frf, session):
        """Walk back over recent sessions; NSE 404s on holidays and before publication."""
        for d in frf._trading_days_back(6):
            df = frf.fetch_bhavcopy(d, session)
            if df is not None and not df.empty:
                return d, df
        return None, None

    def test_real_bhavcopy_parses_into_ml_usable_rollover_rows(self):
        import fno_rollover_fetcher as frf

        # The fetcher's own session: nsearchives refuses a bare requests.Session(), which is
        # why this skipped on every run while production wrote ~211 symbols/day.
        session = frf.make_session()
        trade_date, df = self._recent_bhavcopy(frf, session)
        if df is None:
            pytest.skip("no F&O bhavcopy available in the last 6 sessions from this host")
        assert_non_empty_response(df.to_dict("records"), "fno_rollover_fetcher.fetch_bhavcopy()")

        rows = frf.compute_rollover(df, trade_date)
        if not rows:
            pytest.skip(f"no stock-futures rows in the {trade_date} bhavcopy")
        assert_non_empty_response(rows, "compute_rollover()")

        for r in rows[:25]:
            assert_looks_like_ticker(r["symbol"], "rollover symbol")
            if r.get("rollover_pct") is not None:
                assert_numeric_and_finite(r["rollover_pct"], "rollover_pct")
                # Rollover is a percentage of open interest carried forward; a parse landing
                # on the wrong bhavcopy column (price, OI in absolute contracts) would blow
                # straight past this bound while still being a finite float.
                assert -1.0 <= r["rollover_pct"] <= 200.0, \
                    f"{r['symbol']} rollover_pct {r['rollover_pct']} outside any plausible range"

    def test_real_rollover_stores_and_reads_back_ml_usable(self, mem_db):
        import fno_rollover_fetcher as frf

        # The fetcher's own session: nsearchives refuses a bare requests.Session(), which is
        # why this skipped on every run while production wrote ~211 symbols/day.
        session = frf.make_session()
        trade_date, df = self._recent_bhavcopy(frf, session)
        if df is None:
            pytest.skip("no F&O bhavcopy available in the last 6 sessions from this host")
        rows = frf.compute_rollover(df, trade_date)
        if not rows:
            pytest.skip(f"no stock-futures rows in the {trade_date} bhavcopy")

        frf.ensure_schema(mem_db)
        frf.upsert_rows(rows[:25], mem_db)

        stored = mem_db.execute(
            "SELECT * FROM fno_rollover WHERE symbol = ?", (rows[0]["symbol"],)
        ).fetchall()
        assert stored, f"upsert_rows() wrote nothing readable back for {rows[0]['symbol']}"
        row = dict(stored[0])
        assert_looks_like_ticker(row["symbol"], "stored fno_rollover.symbol")
        assert row.get("rollover_pct") is None or isinstance(row["rollover_pct"], float), \
            f"rollover_pct stored as {type(row['rollover_pct'])}, not a real number"
