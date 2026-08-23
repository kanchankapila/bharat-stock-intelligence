"""
Tests for e2e_lifecycle_check's verdict logic. Pure, no DB.

These pin the two things the check exists for and that a green run cannot demonstrate:
a stage that returned data while SWALLOWING an error must FAIL, and a stage whose newest row
is old must FAIL even though its row count is fine. Both were verified as negative controls
against a live run (monkeypatching a getter to {} flipped the verdict to FAIL / exit 1 while
the Buy/Sell/Hold table still printed) -- these keep that property after the session ends.
"""

import os
import sys
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from e2e_lifecycle_check import MIN_UNIVERSE, _age_days, stage_verdict


class TestStageVerdict:
    def test_healthy_stage_is_alive(self):
        assert stage_verdict(2201) == (True, None)

    def test_empty_map_fails(self):
        alive, note = stage_verdict(0)
        assert alive is False and note == 'EMPTY'

    def test_populated_but_degraded_fails(self):
        """The headline case: a ranker getter with several sub-queries can lose one, swallow
        the exception and still return a full-looking map. Row count reads that as healthy."""
        alive, note = stage_verdict(2201, degraded=True)
        assert alive is False and 'DEGRADED' in note

    def test_collapsed_universe_fails(self):
        alive, note = stage_verdict(MIN_UNIVERSE - 1)
        assert alive is False and 'COLLAPSED' in note

    def test_stale_fails_despite_rows(self):
        alive, note = stage_verdict(326003, age_days=30, max_age_days=5)
        assert alive is False and 'STALE' in note

    def test_unparseable_timestamp_is_stale_not_fresh(self):
        alive, _ = stage_verdict(100, age_days=None, max_age_days=5)
        assert alive is False

    def test_future_dated_row_is_not_stale(self):
        """logical_session_date() rolls a weekend run forward, so unified_recommendations is
        legitimately dated ahead of today. A negative age must not read as staleness."""
        assert stage_verdict(2075, age_days=-2, max_age_days=4) == (True, None)

    def test_no_max_age_means_freshness_is_not_asserted(self):
        assert stage_verdict(2075, age_days=900) == (True, None)


class TestAgeDays:
    def test_none(self):
        assert _age_days(None) is None

    def test_garbage_is_none_not_zero(self):
        assert _age_days('not-a-date') is None

    def test_date_and_datetime_and_text_agree(self):
        d = date.today() - timedelta(days=3)
        assert _age_days(d) == 3
        assert _age_days(datetime(d.year, d.month, d.day)) == 3
        assert _age_days(d.isoformat()) == 3

    def test_postgres_timestamptz_forms(self):
        d = date.today() - timedelta(days=1)
        assert _age_days('%sT17:00:24.120894+00:00' % d) == 1
        assert _age_days('%s 00:35:53.264097+00:00' % d) == 1
        assert _age_days(datetime(d.year, d.month, d.day, 9, 0, tzinfo=timezone.utc)) == 1

    def test_future_date_is_negative(self):
        assert _age_days(date.today() + timedelta(days=2)) == -2
