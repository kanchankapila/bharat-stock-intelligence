"""
Tests for integrity_sweep.py's `_date_eq_filter` -- the 2026-08-29 fix for a query that ran
100+ minutes live (confluence_signals) because `"{datecol}"::text = '{latest}'` casts the
COLUMN, defeating any index on a DATE/TIMESTAMPTZ column for what should be a fast single-day
lookup. Pure function, no DB needed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from integrity_sweep import _date_eq_filter


class TestDateEqFilter:
    def test_date_column_casts_the_literal_not_the_column(self):
        sql = _date_eq_filter("date", "date", "2026-08-29")
        assert sql == "\"date\" = '2026-08-29'::date"
        assert "\"date\"::text" not in sql  # negative control: the old, index-defeating form

    def test_timestamptz_column_casts_the_literal_not_the_column(self):
        sql = _date_eq_filter("computed_at", "timestamp with time zone", "2026-08-29T10:00:00")
        assert sql == "\"computed_at\" = '2026-08-29T10:00:00'::timestamptz"
        assert "::text" not in sql

    def test_text_column_needs_no_cast_at_all(self):
        sql = _date_eq_filter("signal_date", "text", "2026-08-29")
        assert sql == "\"signal_date\" = '2026-08-29'"

    def test_unrecognized_type_falls_back_to_the_original_safe_form(self):
        # Never guess a cast for a type this function doesn't know -- fall back to the
        # original (slow but correct) column-cast form rather than risk an invalid cast on a
        # real production table.
        sql = _date_eq_filter("odd_col", "some_future_type", "2026-08-29")
        assert sql == "\"odd_col\"::text = '2026-08-29'"
