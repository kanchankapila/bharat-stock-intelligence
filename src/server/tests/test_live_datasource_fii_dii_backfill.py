"""Live-datasource test for fii_dii_backfill.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). A "one-time" manual backfill script (not scheduled anywhere in
queues.ts), superseded for ongoing use by fii_dii_history_fetcher.py's investsights.in
source (already covered by test_live_datasource_fii_dii_history.py) -- but this hits a
genuinely different endpoint (portal.tradebrains.in) that was never itself tested.

Lighter-scope than the full round trip (see et_stats' documented precedent for this):
run()/_fetch_all() paginate through the ENTIRE history with no page-count limit, which
would make this test fetch potentially hundreds of pages -- this test instead hits page 1
of both real endpoints directly (the exact request _fetch_all()'s first loop iteration
makes) and parses the result with the fetcher's own parse_tradebrains_rows(), which covers
the fetch+parse+shape half of the mandate without an unbounded-pagination test run.
"""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import fii_dii_backfill as fdb
from live_datasource_helpers import assert_numeric_and_finite


@pytest.mark.live_datasource
class TestFiiDiiBackfillLiveDataSource:
    def test_real_page_one_fetch_and_parse(self):
        """Hits real page 1 of both real TradeBrains FII/DII endpoints, parsed with the
        fetcher's own parse_tradebrains_rows()."""
        fii_resp = requests.get(fdb._FII_URL, params={"page": 1, "per_page": 20},
                                headers=fdb._HEADERS, timeout=30)
        assert fii_resp.status_code == 200, f"FII endpoint returned {fii_resp.status_code}"
        fii_data = fii_resp.json()
        fii_rows = fii_data.get("results", [])
        assert fii_rows, "FII endpoint page 1 returned zero results -- endpoint may be down/changed"

        dii_resp = requests.get(fdb._DII_URL, params={"page": 1, "per_page": 20},
                                headers=fdb._HEADERS, timeout=30)
        assert dii_resp.status_code == 200, f"DII endpoint returned {dii_resp.status_code}"
        dii_data = dii_resp.json()
        dii_rows = dii_data.get("results", [])
        assert dii_rows, "DII endpoint page 1 returned zero results -- endpoint may be down/changed"

        parsed = fdb.parse_tradebrains_rows(fii_rows, dii_rows)
        assert parsed, "parse_tradebrains_rows() produced zero rows from real, non-empty page-1 data"
        sample = parsed[0]
        assert sample["date"], "parsed row missing date"
        assert len(sample["date"]) == 10 and sample["date"][4] == "-", \
            f"date not normalised to ISO YYYY-MM-DD: {sample['date']!r}"
        for col in ("fii_net", "dii_net"):
            if sample.get(col) is not None:
                assert_numeric_and_finite(sample[col], context=f"fii_dii_flow.{col}")
