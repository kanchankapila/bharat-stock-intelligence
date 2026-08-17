"""Live-datasource test for credit_rating_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). One of the ~130 previously-untested fetchers flagged in the
2026-07-30 fifth full-stack-audit pass.

credit_rating_fetcher.py writes via db_compat's module-level execute()/executemany()/
read_df() (not an injectable connection object), so this test monkeypatches those three
names as bound in the credit_rating_fetcher module to shims backed by a private in-memory
SQLite connection -- keeps the DB round trip fully isolated from the real production DB
without needing to change the fetcher's own code.
"""
import os
import sqlite3
import sys
from datetime import date, timedelta

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402
import credit_rating_fetcher as crf
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable

# NSE's own event count is unpredictable day to day (rating actions are sporadic), so this
# test uses a wide 365-day window -- wide enough that at least one real event should exist
# across the whole NSE-listed universe, without pinning to any single symbol.


def _install_shims(monkeypatch):
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row

    def shim_execute(sql, params=None):
        conn.execute(sql, params or [])
        conn.commit()

    def shim_executemany(sql, seq_of_params):
        conn.executemany(sql, seq_of_params)
        conn.commit()

    def shim_read_df(sql):
        return pd.read_sql_query(sql, conn)

    monkeypatch.setattr(crf, "execute", shim_execute)
    monkeypatch.setattr(crf, "executemany", shim_executemany)
    monkeypatch.setattr(crf, "read_df", shim_read_df)
    return conn


@pytest.mark.live_datasource
class TestCreditRatingLiveDataSource:
    def test_real_fetch_parses_ml_usable_events(self):
        """Step 1-3: hit the real NSE corporate-credit-rating endpoint, parse with the
        fetcher's own parse_announcements(), assert every event is ML-usable."""
        today = date.today()
        to_date = today.strftime("%d-%m-%Y")
        from_date = (today - timedelta(days=365)).strftime("%d-%m-%Y")

        raw_rows = crf.fetch_nse_rating_announcements(from_date, to_date)
        assert_non_empty_response(raw_rows, "fetch_nse_rating_announcements (365d window)")

        events = crf.parse_announcements(raw_rows, bse_nse_map={})
        assert events, f"NSE returned {len(raw_rows)} raw rows but none parsed into events"

        for e in events:
            assert e["bse_code"], "event missing its AppID-derived uniqueness key"
            assert e["announcement_date"], "event missing announcement_date"
            assert e["action"] in ("UPGRADE", "DOWNGRADE", "REAFFIRM", "UNKNOWN"), \
                f"unexpected action classification: {e['action']!r}"

    def test_real_fetch_stores_ml_usable_rows(self, monkeypatch):
        """Step 4-5: write through the fetcher's own upsert_events() into a throwaway
        in-memory SQLite DB (via monkeypatched execute/executemany/read_df), then read the
        rows back and validate they're ML-usable."""
        conn = _install_shims(monkeypatch)
        crf.ensure_credit_rating_table(conn)

        today = date.today()
        to_date = today.strftime("%d-%m-%Y")
        from_date = (today - timedelta(days=365)).strftime("%d-%m-%Y")
        raw_rows = crf.fetch_nse_rating_announcements(from_date, to_date)
        assert_non_empty_response(raw_rows, "fetch_nse_rating_announcements (365d window)")
        events = crf.parse_announcements(raw_rows, bse_nse_map={})
        assert events

        crf.upsert_events(conn, events)

        stored = conn.execute("SELECT * FROM credit_rating_events LIMIT 1").fetchone()
        assert stored is not None, "no row landed in credit_rating_events after upsert_events()"
        assert_stored_row_ml_usable(dict(stored), numeric_cols=[], ticker_cols=[], context="credit_rating_events")
        # bse_code (NSE's AppID) is this table's real uniqueness key, not a stock ticker --
        # validated directly instead of via assert_looks_like_ticker.
        assert dict(stored)["bse_code"], "bse_code (AppID) missing from stored row"

        count = conn.execute("SELECT COUNT(*) FROM credit_rating_events").fetchone()[0]
        assert count == len(set((e["bse_code"], e["announcement_date"], e["rating_agency"]) for e in events)), \
            "stored row count doesn't match the distinct (bse_code, announcement_date, rating_agency) key count"
