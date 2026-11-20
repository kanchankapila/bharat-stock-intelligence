"""Live-datasource test for nse_corporate_announcements_fetcher (data-sources.md mandate, AF-20261120-01).

Runs the fetcher's own main() path pieces (its NseClient, URL, parser and upsert) against the real NSE
announcements API for the last 3 days, into a throwaway schema (pg_conn), and reads the rows back.
Skipped unless RUN_LIVE_DATASOURCE_TESTS=1.
"""
import datetime as dt
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import nse_corporate_announcements_fetcher as na  # noqa: E402
from live_datasource_helpers import assert_looks_like_ticker  # noqa: E402
from nse_filings_common import NseClient  # noqa: E402


@pytest.mark.live_datasource
def test_last_three_days_of_filings_store_with_ids_and_times(pg_conn):
    today = dt.datetime.now(na.IST).date()
    since = today - dt.timedelta(days=3)
    payload = NseClient(max_requests=4).get_json(na.URL.format(f=since.strftime("%d-%m-%Y"), t=today.strftime("%d-%m-%Y")))
    rows = na.parse(payload)
    assert len(rows) >= 50, len(rows)  # several hundred filings a trading day
    na.ensure_schema(pg_conn)
    assert na.upsert(pg_conn, rows) == len(rows)
    stored = pg_conn.execute(f"SELECT seq_id, symbol, category, disseminated_at FROM {na.TABLE}").fetchall()
    assert len(stored) == len({r["seq_id"] for r in rows})
    for seq, sym, cat, when in stored:
        assert seq.isdigit(), seq
        assert_looks_like_ticker(sym, context=f"{na.TABLE}.symbol")
        assert cat, seq
        assert since - dt.timedelta(days=1) <= when.astimezone(na.IST).date() <= today, (seq, when)
