"""Live-datasource test for mc_eco_calendar_fetcher.py (see CLAUDE.md's "Adding a new data
source" mandatory rule). execute()/executemany() are bare module-level functions imported
from db_compat (no `con` parameter) -- monkeypatch-the-module pattern, same as the nt_*
fetchers.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import mc_eco_calendar_fetcher as mec
from live_datasource_helpers import assert_numeric_and_finite


class _CaptureDB:
    def __init__(self):
        self.executemany_calls = []

    def executemany(self, sql, rows):
        self.executemany_calls.extend((sql, row) for row in rows)


@pytest.mark.live_datasource
class TestMcEcoCalendarFetcherLiveDataSource:
    def test_real_fetch_produces_events(self):
        """Hits the real MC eco-calendar upcoming-events endpoint via the fetcher's own
        fetch_events()."""
        events = mec.fetch_events()
        assert events, "fetch_events() returned zero events across 3 pages -- endpoint may be down/changed"
        sample = events[0]
        assert sample.get("calendarId"), "an event is missing calendarId entirely"
        assert sample.get("date"), "an event is missing its date"

    def test_upsert_and_feature_compute_write_ml_usable_rows(self):
        """Writes real fetched events through the fetcher's own _upsert_eco_calendar()/
        _compute_and_upsert_macro_features(), with executemany() monkeypatched to a capture
        object instead of the real DB."""
        events = mec.fetch_events()
        assert events, "no real events to exercise the write path with"

        cap = _CaptureDB()
        orig_executemany = mec.executemany
        mec.executemany = cap.executemany
        try:
            mec._upsert_eco_calendar(events)
            high3, india7, crit1 = mec._compute_and_upsert_macro_features(events)
        finally:
            mec.executemany = orig_executemany

        eco_calls = [(sql, r) for sql, r in cap.executemany_calls if "eco_calendar" in sql]
        assert eco_calls, "_upsert_eco_calendar() made no writes despite real events"
        for sql, row in eco_calls[:5]:
            calendar_id = row[0]
            assert calendar_id, "eco_calendar.calendar_id is empty"

        macro_calls = [(sql, r) for sql, r in cap.executemany_calls if "macro_asset_prices" in sql]
        assert macro_calls, "_compute_and_upsert_macro_features() made no macro_asset_prices writes"
        assert len(macro_calls) == 3, f"expected exactly 3 summary features, got {len(macro_calls)}"
        for sql, row in macro_calls:
            date, symbol, close = row[0], row[1], row[2]
            assert symbol in ("HIGH_IMPACT_EVENTS_3D", "INDIA_EVENTS_7D", "CRITICAL_EVENTS_1D")
            assert_numeric_and_finite(close, context=f"macro_asset_prices.{symbol}")
        assert high3 >= 0 and india7 >= 0 and crit1 >= 0
