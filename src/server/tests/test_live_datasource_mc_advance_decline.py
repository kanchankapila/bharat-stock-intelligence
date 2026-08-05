"""Live-datasource test for mc_advance_decline_fetcher.py (see CLAUDE.md's "Adding a new
data source" mandatory rule). execute()/executemany() are bare module-level functions
imported from db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as the
nt_* fetchers.
"""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mc_advance_decline_fetcher as mad
from live_datasource_helpers import assert_numeric_and_finite


class _CaptureDB:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))


@pytest.mark.live_datasource
class TestMcAdvanceDeclineFetcherLiveDataSource:
    def test_real_fetch_produces_ml_usable_record(self):
        """Hits the real MC exchange-advdec endpoint for NSE via the fetcher's own
        fetch_adv_dec()."""
        session = requests.Session()
        session.headers.update(mad.HEADERS)
        rec = mad.fetch_adv_dec(session, "N")
        assert rec is not None, "fetch_adv_dec(ex=N) returned None -- endpoint may be down/blocked"
        assert rec["date"], "advance/decline record missing date"
        assert rec["advances"] >= 0 and rec["declines"] >= 0, \
            f"advances/declines should never be negative: {rec}"
        if rec["ratio"] is not None:
            assert_numeric_and_finite(rec["ratio"], context="adv_dec_ratio")

    def test_upsert_writes_ml_usable_rows(self):
        """Writes a real fetched NSE record through the fetcher's own upsert_adv_dec(), with
        execute() monkeypatched to a capture object instead of the real DB."""
        session = requests.Session()
        session.headers.update(mad.HEADERS)
        rec = mad.fetch_adv_dec(session, "N")
        assert rec is not None, "no real record to exercise the write path with"

        cap = _CaptureDB()
        orig_execute = mad.execute
        mad.execute = cap.execute
        try:
            mad.upsert_adv_dec("NSE", rec)
        finally:
            mad.execute = orig_execute

        assert cap.calls, "upsert_adv_dec() made no execute() calls at all"
        ad_calls = [(sql, p) for sql, p in cap.calls if "mc_advance_decline" in sql]
        assert ad_calls, "upsert_adv_dec() never wrote to mc_advance_decline"
        sql, params = ad_calls[0]
        date, exchange, advances, declines, unchanged, ratio, fetched_at = params
        assert date == rec["date"]
        assert exchange == "NSE"
        assert advances == rec["advances"]

        breadth_calls = [(sql, p) for sql, p in cap.calls if "market_breadth" in sql]
        assert breadth_calls, "upsert_adv_dec() should also update market_breadth for NSE"
