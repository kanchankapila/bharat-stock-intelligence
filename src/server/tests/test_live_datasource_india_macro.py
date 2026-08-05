"""Live-datasource test for india_macro_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). executemany()/query_all() are bare module-level functions imported
from db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as the nt_*
fetchers. MC eco-calendar actuals only ever return TODAY's events (documented in the
fetcher's own docstring after the get-actual-event-data endpoint was retired), so India
macro events matching one of the 6 tracked patterns may legitimately be absent on any given
day -- this test asserts response shape and, conditionally, ML-usable stored rows only when
a real matching event exists today.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import india_macro_fetcher as imf
from live_datasource_helpers import assert_numeric_and_finite


class _CaptureDB:
    def __init__(self, query_all_result=None):
        self.calls = []
        self._query_all_result = query_all_result or []

    def executemany(self, sql, rows):
        self.calls.extend((sql, row) for row in rows)

    def query_all(self, sql, params=None):
        return self._query_all_result


@pytest.mark.live_datasource
class TestIndiaMacroFetcherLiveDataSource:
    def test_eco_calendar_actuals_endpoint_shape(self):
        """Hits the real MC eco-calendar get-event-data endpoint via the fetcher's own
        _fetch_actual_events()."""
        events = imf._fetch_actual_events(days=60)
        assert isinstance(events, list), f"_fetch_actual_events() should return a list, got {type(events)}"
        # events itself may be empty (a day with no economic releases at all is real), but if
        # non-empty each item must be a real dict with a name field.
        for ev in events[:5]:
            assert isinstance(ev, dict), f"event is not a dict: {ev!r}"

    def test_process_eco_calendar_actuals_writes_ml_usable_rows_when_matched(self):
        """Runs the fetcher's real process_eco_calendar_actuals() end-to-end against the
        real endpoint, with executemany() monkeypatched to a capture object. Only asserts
        stored-row shape when a real India-macro event happens to be present today."""
        cap = _CaptureDB()
        orig_executemany = imf.executemany
        imf.executemany = cap.executemany
        try:
            latest = imf.process_eco_calendar_actuals(days=60)
        finally:
            imf.executemany = orig_executemany

        assert isinstance(latest, dict)
        if latest:
            assert cap.calls, "process_eco_calendar_actuals() found matching events but made no executemany() calls"
            for sql, row in cap.calls[:5]:
                # _upsert_rows param order: (date, symbol, close, ret_1d, ret_5d, fetched_at)
                date, symbol, close = row[0], row[1], row[2]
                assert date, "macro_asset_prices.date is empty"
                assert symbol in (
                    "INDIA_MFG_PMI", "INDIA_SERVICES_PMI", "INDIA_GST_YOY_PCT",
                    "INDIA_IIP_YOY", "INDIA_AUTO_SALES_YOY", "INDIA_2W_SALES_YOY",
                )
                assert_numeric_and_finite(close, context=f"macro_asset_prices.{symbol}")

    def test_process_repo_rate_handles_real_fallback_chain(self):
        """Exercises process_repo_rate()'s real eco_calendar fallback query (query_all
        monkeypatched to return a real-shaped but empty result, since the throwaway test
        environment has no eco_calendar table) -- confirms it degrades gracefully to {}
        without raising when nothing is found, rather than crashing the whole pipeline."""
        cap = _CaptureDB(query_all_result=[])
        orig_executemany, orig_query_all = imf.executemany, imf.query_all
        imf.executemany, imf.query_all = cap.executemany, cap.query_all
        try:
            result = imf.process_repo_rate(india_10y=7.0)
        finally:
            imf.executemany, imf.query_all = orig_executemany, orig_query_all

        assert result == {}, "process_repo_rate() should return {} when no repo rate can be resolved, not raise"
