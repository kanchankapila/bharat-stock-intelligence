"""
Regression tests for as_of.logical_trading_date() (2026-08-01).

Context: ml-daily-ops's step chain has grown long enough to regularly finish after midnight
IST (confirmed via job_heartbeat: a run processing the 2026-07-31 trading day completed at
2026-08-01 01:23 IST). Post-close enrichment scripts that took a naive
date.today()/datetime.now() as their `UPDATE ... WHERE date = ?` write-target silently wrote
into a calendar day with no grid row yet -- 0 rows matched, no error. Found live in
insider_features.py: its 2026-08-01 date_iso fix was itself invisible in production because
the write it should have produced was silently dropped by this exact bug.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from as_of import logical_trading_date


class TestLogicalTradingDate:
    def test_daytime_uses_the_real_calendar_date(self):
        now = datetime.datetime(2026, 7, 31, 20, 15)  # 8:15pm, well before midnight
        assert logical_trading_date(now=now) == '2026-07-31'

    def test_just_before_cutoff_still_treated_as_yesterday(self):
        now = datetime.datetime(2026, 8, 1, 3, 59)  # 3:59am, before the default 4am cutoff
        assert logical_trading_date(now=now) == '2026-07-31'

    def test_at_cutoff_is_the_real_calendar_date(self):
        now = datetime.datetime(2026, 8, 1, 4, 0)
        assert logical_trading_date(now=now) == '2026-08-01'

    def test_regression_case_ml_daily_ops_actually_hit(self):
        """job_heartbeat showed the 2026-07-31 run completing at 2026-08-01 01:23 IST -- this
        must resolve to '2026-07-31', the day whose technical_signals grid actually exists."""
        now = datetime.datetime(2026, 8, 1, 1, 23)
        assert logical_trading_date(now=now) == '2026-07-31'

    def test_naive_datetime_today_would_get_this_wrong(self):
        """Negative control: documents exactly what a raw date.today() call would have
        returned for the same real-world moment -- the wrong trading day."""
        now = datetime.datetime(2026, 8, 1, 1, 23)
        naive_today = now.date().isoformat()
        assert naive_today == '2026-08-01'
        assert naive_today != logical_trading_date(now=now)

    def test_custom_cutoff_hour_respected(self):
        now = datetime.datetime(2026, 8, 1, 5, 30)
        assert logical_trading_date(cutoff_hour=6, now=now) == '2026-07-31'
        assert logical_trading_date(cutoff_hour=4, now=now) == '2026-08-01'

    def test_defaults_to_real_now_when_unspecified(self):
        """Smoke test only -- must not raise, and must return a well-formed ISO date close to
        the real wall-clock date (within a day, accounting for the cutoff)."""
        result = logical_trading_date()
        parsed = datetime.date.fromisoformat(result)
        assert (datetime.date.today() - parsed).days in (0, 1)
