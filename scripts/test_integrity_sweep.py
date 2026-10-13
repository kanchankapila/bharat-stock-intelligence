"""
Tests for integrity_sweep.py's `_date_eq_filter` -- the 2026-08-29 fix for a query that ran
100+ minutes live (confluence_signals) because `"{datecol}"::text = '{latest}'` casts the
COLUMN, defeating any index on a DATE/TIMESTAMPTZ column for what should be a fast single-day
lookup. Pure function, no DB needed.
"""

import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import integrity_sweep
from integrity_sweep import (
    EXPECTED_DEAD_COLUMNS,
    EXPECTED_FROZEN_COLUMNS,
    TABLE_ROW_SCOPES,
    _date_eq_filter,
    _partition_expected,
)


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


class TestExpectedFindings:
    def test_every_exception_has_a_nonempty_reason(self):
        assert EXPECTED_DEAD_COLUMNS
        assert EXPECTED_FROZEN_COLUMNS
        assert all(reason.strip() for reason in EXPECTED_DEAD_COLUMNS.values())
        assert all(reason.strip() for reason in EXPECTED_FROZEN_COLUMNS.values())

    def test_suppression_is_exact_not_column_name_global(self):
        actionable, suppressed = _partition_expected(
            "technical_signals", ["cs_score", "target_ret_5d"], EXPECTED_DEAD_COLUMNS
        )
        assert actionable == ["target_ret_5d"]
        assert set(suppressed) == {"cs_score"}

        # The same name on another table is actionable: table+column is the contract.
        actionable, suppressed = _partition_expected(
            "some_other_table", ["cs_score"], EXPECTED_DEAD_COLUMNS
        )
        assert actionable == ["cs_score"]
        assert suppressed == {}


def test_latest_date_expr_skips_unparseable_text_date_for_fetched_at(monkeypatch):
    columns = pd.DataFrame([
        {"column_name": "date", "data_type": "text"},
        {"column_name": "fetched_at", "data_type": "timestamp with time zone"},
    ])

    def fake_read_df(sql):
        if "information_schema.columns" in sql:
            return columns
        if 'MAX("date")' in sql:
            raise RuntimeError('invalid input syntax for type date: "Mar 2024"')
        if 'MAX("fetched_at")' in sql:
            return pd.DataFrame([{"m": "2026-10-11 12:00:00+00"}])
        raise AssertionError(sql)

    monkeypatch.setattr(integrity_sweep, "read_df", fake_read_df)
    monkeypatch.setattr(integrity_sweep, "_enriched_through", lambda: "2026-10-12")

    date_col, latest, _ = integrity_sweep.latest_date_expr("mc_earnings_forecast")
    assert date_col == "fetched_at"
    assert latest == "2026-10-11 12:00:00+00"


def test_latest_date_expr_prefers_business_date_over_batch_timestamp(monkeypatch):
    columns = pd.DataFrame([
        {"column_name": "computed_at", "data_type": "timestamp with time zone"},
        {"column_name": "signal_date", "data_type": "date"},
    ])
    queries = []

    def fake_read_df(sql):
        queries.append(sql)
        if "information_schema.columns" in sql:
            return columns
        if 'MAX("signal_date")' in sql:
            return pd.DataFrame([{"m": "2026-10-08"}])
        raise AssertionError(f"computed_at was consulted before signal_date: {sql}")

    monkeypatch.setattr(integrity_sweep, "read_df", fake_read_df)
    monkeypatch.setattr(integrity_sweep, "_enriched_through", lambda: "2026-10-12")

    date_col, latest, _ = integrity_sweep.latest_date_expr("signal_outcomes")
    assert date_col == "signal_date"
    assert latest == "2026-10-08"
    assert not any('MAX("computed_at")' in sql for sql in queries)


def test_signal_outcomes_anchor_is_scoped_to_technical_writer(monkeypatch):
    columns = pd.DataFrame([
        {"column_name": "signal_date", "data_type": "date"},
        {"column_name": "signal_source", "data_type": "text"},
        {"column_name": "max_return_pct", "data_type": "double precision"},
    ])
    queries = []

    def fake_read_df(sql):
        queries.append(sql)
        if "information_schema.columns" in sql:
            return columns
        if 'MAX("signal_date")' in sql:
            return pd.DataFrame([{"m": "2026-10-09"}])
        raise AssertionError(sql)

    monkeypatch.setattr(integrity_sweep, "read_df", fake_read_df)
    monkeypatch.setattr(integrity_sweep, "_enriched_through", lambda: "2026-10-13")

    date_col, latest, _ = integrity_sweep.latest_date_expr("signal_outcomes")
    assert date_col == "signal_date" and latest == "2026-10-09"
    assert TABLE_ROW_SCOPES["signal_outcomes"][0] in queries[-1]
