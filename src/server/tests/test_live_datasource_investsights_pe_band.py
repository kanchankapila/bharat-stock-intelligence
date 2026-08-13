"""Live-datasource test for investsights_pe_band_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

**Known state, 2026-08-13**: the `/fundamentals/{symbol}/pe-band` endpoint returned this
fetcher's full documented schema (`pe_bands`/`chart` back to 2023-08-14) earlier in the same
session it was onboarded, then started 404ing for every symbol and every path variant tried
(with/without trailing slash, `/pe-bands`, `/peband`, `/pe_band`, `/valuation/.../pe-band`,
`v1` prefix) while every sibling `/fundamentals/{symbol}/*` endpoint on the same host kept
working normally. This looks like a real, external endpoint removal/rename, not a fetcher bug
-- flagged per `feedback_failing_urls.md` rather than guessed around. This test pins that
state explicitly (expects 404) so a future run flipping back to 200 is a visible, welcome
surprise instead of a silent assumption either way.
"""
import os
import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import investsights_pe_band_fetcher as pb


def _session():
    s = requests.Session()
    s.headers.update(pb.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsPeBandLiveDataSource:
    def test_endpoint_currently_404s_or_recovers(self):
        """Documents current reality rather than assuming either state. If this starts
        failing because the endpoint is back (raises instead of returning None), that's
        good news -- update this test to assert real chart data via parse_chart_rows()."""
        session = _session()
        try:
            data = pb.fetch_pe_band(session, "RELIANCE")
        except requests.HTTPError as e:
            assert e.response.status_code == 404, (
                f"expected the known 404, got {e.response.status_code} -- investigate"
            )
            return
        # Endpoint recovered -- verify the real, previously-documented shape end to end.
        assert data is not None
        rows = pb.parse_chart_rows("RELIANCE", data)
        assert rows, "pe-band endpoint returned data but parse_chart_rows() produced no rows"
        con = sqlite3.connect(":memory:")
        pb.ensure_schema(con)
        assert pb.store_rows(con, rows) == len(rows)
