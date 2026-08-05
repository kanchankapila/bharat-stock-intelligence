"""Live-datasource test for mmi_fetcher.py (see CLAUDE.md's "Adding a new data source"
mandatory rule). execute() is a bare module-level function imported from db_compat (no
`con` parameter) -- monkeypatch-the-module pattern, same as the nt_* fetchers.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mmi_fetcher as mmi
from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite


class _CaptureDB:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))


@pytest.mark.live_datasource
class TestMmiFetcherLiveDataSource:
    def test_real_fetch_returns_ml_usable_indicator(self):
        """Hits the real Tickertape MMI endpoint via the fetcher's own fetch_mmi()."""
        data = mmi.fetch_mmi()
        assert_non_empty_response(data, "fetch_mmi()")
        indicator = mmi._f(data.get("indicator"))
        assert indicator is not None, "MMI indicator value missing/unparseable"
        # India MMI is a bounded 0-100 fear/greed gauge -- catches a parse landing on the
        # wrong JSON field entirely (e.g. a raw internal id instead of the indicator value).
        assert 0.0 <= indicator <= 100.0, f"MMI indicator {indicator} outside the valid 0-100 range"

    def test_upsert_writes_ml_usable_rows(self):
        """Writes the real fetched MMI value + historical anchors through the fetcher's own
        _upsert(), with execute() monkeypatched to a capture object instead of the real DB."""
        data = mmi.fetch_mmi()
        assert_non_empty_response(data, "fetch_mmi()")

        cap = _CaptureDB()
        orig_execute = mmi.execute
        mmi.execute = cap.execute
        try:
            date_str = str(data.get("date", ""))[:10]
            value = mmi._f(data.get("indicator"))
            wrote = mmi._upsert(date_str, value)
        finally:
            mmi.execute = orig_execute

        assert wrote is True, "_upsert() reported failure for a real, valid MMI value"
        assert cap.calls, "_upsert() made no execute() calls despite reporting success"
        sql, params = cap.calls[0]
        assert "macro_asset_prices" in sql
        assert "INDIA_MMI" in sql
        written_date, written_value = params
        assert written_date == date_str
        assert_numeric_and_finite(written_value, context="macro_asset_prices.INDIA_MMI.close")
