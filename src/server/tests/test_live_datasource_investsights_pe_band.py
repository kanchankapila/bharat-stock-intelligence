"""Live-datasource test for investsights_pe_band_fetcher.py
(CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.

**History note**: this fetcher was originally built against the wrong base path
(`/fundamentals/{symbol}/pe-band`), which 404s -- confused for a dead/removed endpoint until
the user supplied the real, working path (`/market/pe-band/{symbol}?days=N`) on 2026-08-14.
See the fetcher's own module docstring for the full correction. Lesson pinned there, not
repeated here: a 404 on every guessed path variant means "the guesses are wrong," not "the
endpoint is dead" -- the two look identical from the client side.
"""
import os
import sqlite3
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import investsights_pe_band_fetcher as pb
from live_datasource_helpers import assert_non_empty_response, assert_stored_row_ml_usable


def _session():
    s = requests.Session()
    s.headers.update(pb.HEADERS)
    return s


@pytest.mark.live_datasource
class TestInvestsightsPeBandLiveDataSource:
    def test_real_fetch_has_dense_chart_history(self):
        data = pb.fetch_pe_band(_session(), "RELIANCE")
        assert_non_empty_response(data, "fetch_pe_band(RELIANCE)")
        chart = data.get("chart")
        assert_non_empty_response(chart, "pe-band.chart")
        assert len(chart) > 100, f"expected dense multi-year history, got {len(chart)} points"
        assert chart[0]["date"] < chart[-1]["date"], "chart must be chronologically ordered"

    def test_stored_row_is_ml_usable(self):
        session = _session()
        data = pb.fetch_pe_band(session, "RELIANCE")
        rows = pb.parse_chart_rows("RELIANCE", data)
        assert rows

        con = sqlite3.connect(":memory:")
        pb.ensure_schema(con)
        assert pb.store_rows(con, rows) == len(rows)

        cur = con.execute(
            "SELECT symbol, date, price, pe, band_median FROM investsights_pe_band_history "
            "ORDER BY date DESC LIMIT 1"
        )
        cols = [d[0] for d in cur.description]
        stored = dict(zip(cols, cur.fetchone()))
        assert_stored_row_ml_usable(
            stored, numeric_cols=["price", "pe", "band_median"],
            ticker_cols=["symbol"], context="investsights_pe_band_history",
        )
        assert len(stored["date"]) == 10 and stored["date"][4] == "-", (
            f"date not ISO: {stored['date']}"
        )
