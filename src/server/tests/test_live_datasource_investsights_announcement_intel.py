"""Live-datasource test for investsights_announcement_intel_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

Pins the one real quirk found onboarding this endpoint: `/documents` 404s WITH a trailing
slash and 200s WITHOUT one (opposite of most APIs' usual leniency) -- confirmed live
2026-08-13.
"""
import os
import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
from pg_test_support import pg_memory_conn  # noqa: E402

import investsights_announcement_intel_fetcher as ai
from live_datasource_helpers import assert_non_empty_response, assert_looks_like_ticker


def _session():
    s = requests.Session()
    s.headers.update(ai.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsAnnouncementIntelLiveDataSource:
    def test_real_fetch_returns_filings_grouped_by_category(self):
        payload = ai.fetch_documents(_session(), "WEBELSOLAR")
        assert_non_empty_response(payload, "fetch_documents(WEBELSOLAR)")
        filings = payload.get("filings")
        assert_non_empty_response(filings, "documents.filings")
        assert "announcement" in filings, "expected an 'announcement' category"

    def test_stored_rows_are_ml_usable(self):
        session = _session()
        payload = ai.fetch_documents(session, "WEBELSOLAR")
        rows = ai.parse_rows("WEBELSOLAR", payload)
        assert rows, "no filing rows parsed from a real response"

        con = pg_memory_conn()
        ai.ensure_schema(con)
        assert ai.store_rows(con, rows) == len(rows)

        symbol, uid, category, announcement_date = con.execute(
            "SELECT symbol, uid, category, announcement_date "
            "FROM investsights_announcement_intel WHERE announcement_date IS NOT NULL LIMIT 1"
        ).fetchone()
        assert_looks_like_ticker(symbol, "symbol")
        assert uid, "uid (the provider-issued PK component) must not be empty"
        assert category, "category must not be empty"
        assert len(announcement_date) == 10 and announcement_date[4] == "-", (
            f"announcement_date not ISO: {announcement_date}"
        )

    def test_dedup_on_source_uid_composite_key(self):
        """Composite-key rule (data-sources.md): PK is (source, uid), never a bare
        provider-issued uid alone. Re-storing the same rows must not duplicate."""
        session = _session()
        payload = ai.fetch_documents(session, "WEBELSOLAR")
        rows = ai.parse_rows("WEBELSOLAR", payload)
        assert rows

        con = pg_memory_conn()
        ai.ensure_schema(con)
        ai.store_rows(con, rows)
        ai.store_rows(con, rows)  # re-store the identical batch
        (count,) = con.execute("SELECT COUNT(*) FROM investsights_announcement_intel").fetchone()
        assert count == len(rows), "re-storing the same rows must upsert, not duplicate"
