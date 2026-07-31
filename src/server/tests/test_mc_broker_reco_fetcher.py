"""Regression test for mc_broker_reco_fetcher.py's fetch_recos() pagination bug, found
2026-07-31 while writing its live_datasource test: the MC broker-reco API's reco_data is
NOT sorted chronologically (live-verified: a single 100-row page mixed 2025-04-29 through
2026-07-28 entry_dates with no discernible order). The old code broke out of the ENTIRE
fetch on the first stale row found per page, silently dropping genuinely recent recs that
happened to sit later in the same page -- and could return a fully empty result on a day
the very first row was old, even though the same page held real recent recos.
"""
import datetime as real_datetime
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_broker_reco_fetcher as mbr


def _make_row(entry_date, scid="TESTCO"):
    return {
        "scId": scid, "stock_name": "Test Co", "organization": "Test Broker",
        "recommend_flag": "BUY", "recommended_price": "100", "target": "120",
        "entry_date": entry_date, "recommend_date": entry_date[:10],
    }


class TestFetchRecosNonChronologicalOrdering:
    def test_recent_row_after_a_stale_row_on_the_same_page_is_kept(self):
        """A page with an OLD row first and a RECENT row later must keep the recent one --
        this is exactly the shape of the real API response that broke the old code."""
        page = [
            _make_row("2025-04-29 20:51:52"),   # stale (>10 days old)
            _make_row("2026-07-28 14:24:49"),   # recent
        ]
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"success": 1, "data": {"reco_data": page}}

        call_count = {"n": 0}

        def fake_retry_get(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] > 1:
                empty = MagicMock()
                empty.json.return_value = {"success": 1, "data": {"reco_data": []}}
                return empty
            return mock_resp

        with patch("mc_broker_reco_fetcher.retry_get", side_effect=fake_retry_get), \
             patch("mc_broker_reco_fetcher.datetime") as mock_dt:
            mock_dt.datetime.now.return_value = real_datetime.datetime(2026, 7, 31, 12, 0, 0)
            mock_dt.datetime.strptime = real_datetime.datetime.strptime
            mock_dt.timedelta = real_datetime.timedelta
            recos = mbr.fetch_recos(lookback_days=10)

        assert len(recos) == 1, f"expected exactly the 1 recent row to survive, got {len(recos)}"
        assert recos[0]["entry_date"] == "2026-07-28 14:24:49"

    def test_all_stale_page_returns_empty_without_crashing(self):
        page = [_make_row("2025-01-01 00:00:00")]
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"success": 1, "data": {"reco_data": page}}

        call_count = {"n": 0}

        def fake_retry_get(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] > 1:
                empty = MagicMock()
                empty.json.return_value = {"success": 1, "data": {"reco_data": []}}
                return empty
            return mock_resp

        with patch("mc_broker_reco_fetcher.retry_get", side_effect=fake_retry_get), \
             patch("mc_broker_reco_fetcher.datetime") as mock_dt:
            mock_dt.datetime.now.return_value = real_datetime.datetime(2026, 7, 31, 12, 0, 0)
            mock_dt.datetime.strptime = real_datetime.datetime.strptime
            mock_dt.timedelta = real_datetime.timedelta
            recos = mbr.fetch_recos(lookback_days=10)

        assert recos == []
