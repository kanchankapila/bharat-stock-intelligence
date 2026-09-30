"""Live-datasource test for nt_change_oi_fetcher.py (CLAUDE.md, "Adding a New Data Source").

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
Goes through the fetcher's own index map, URL builder and parser. Asserts the change columns
VARY: AF-20260930-20 stored 0.0 on every row for weeks while every freshness check stayed green.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import nt_change_oi_fetcher as nt
from live_datasource_helpers import assert_non_empty_response


@pytest.mark.live_datasource
class TestNtChangeOiLiveDataSource:
    def test_real_fetch_carries_nonzero_oi_changes(self):
        nt_symbol, exchange = nt._get_nt_index_map()["NIFTY50"]
        rows = nt.fetch_change_oi(nt_symbol, "15:20:00", exchange)
        assert_non_empty_response(rows, "fetch_change_oi(NIFTY50)")
        changes = {r.get("calls_change_oi") for r in rows} | {r.get("puts_change_oi") for r in rows}
        assert len(changes) > 5, f"change-OI collapsed to {changes!r} -- zero-width window again?"
