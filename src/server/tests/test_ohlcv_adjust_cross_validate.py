"""Regression tests for ohlcv_adjust.cross_validate_with_mc_actions() (2026-08-07).

This is deliberately additive to the pre-existing heuristic detector -- these tests focus on
the three outcomes (confirmed / filled / disagreement) and, most importantly, that a
disagreement NEVER silently overwrites an existing heuristic-detected factor (double-adjustment
risk), matching the module's own stated "report, don't guess" philosophy.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ohlcv_adjust as oa


def _make_db():
    con = sqlite3.connect(":memory:")
    con.execute("""
        CREATE TABLE ohlcv_adjustment_factors (
            symbol TEXT, ex_date TEXT, factor REAL, source TEXT DEFAULT 'bhavcopy_prev_close',
            PRIMARY KEY (symbol, ex_date)
        )
    """)
    con.execute("""
        CREATE TABLE stock_corporate_action_history (
            symbol TEXT, action_type TEXT, event_key TEXT, announce_date TEXT,
            record_date TEXT, ratio_text TEXT, ratio_factor REAL, amount REAL, detail TEXT,
            PRIMARY KEY (symbol, action_type, event_key)
        )
    """)
    con.commit()
    return con


def _add_heuristic(con, symbol, ex_date, factor, source='bhavcopy_prev_close'):
    con.execute("INSERT INTO ohlcv_adjustment_factors VALUES (?,?,?,?)", (symbol, ex_date, factor, source))
    con.commit()


def _add_authoritative(con, symbol, atype, record_date, ratio_factor, ratio_text='1:10'):
    con.execute(
        "INSERT INTO stock_corporate_action_history "
        "(symbol, action_type, event_key, record_date, ratio_text, ratio_factor) VALUES (?,?,?,?,?,?)",
        (symbol, atype, f"{symbol}-{atype}-{record_date}", record_date, ratio_text, ratio_factor),
    )
    con.commit()


class TestConfirmed:
    def test_matching_heuristic_factor_within_window_is_confirmed_not_touched(self):
        con = _make_db()
        _add_heuristic(con, 'NESTLEIND', '2024-01-05', 0.1)
        _add_authoritative(con, 'NESTLEIND', 'split', '2024-01-05', 0.1)
        res = oa.cross_validate_with_mc_actions(con, persist=True)
        assert len(res['confirmed']) == 1
        assert res['filled'] == []
        assert res['disagreement'] == []
        # source must remain the heuristic's own -- confirming never overwrites
        row = con.execute("SELECT source FROM ohlcv_adjustment_factors WHERE symbol='NESTLEIND'").fetchone()
        assert row[0] == 'bhavcopy_prev_close'

    def test_dates_within_window_but_not_exact_still_confirm(self):
        con = _make_db()
        _add_heuristic(con, 'X', '2024-01-06', 0.5)   # a day off the authoritative record_date
        _add_authoritative(con, 'X', 'bonus', '2024-01-05', 0.5)
        res = oa.cross_validate_with_mc_actions(con)
        assert len(res['confirmed']) == 1


class TestFilled:
    def test_no_heuristic_factor_anywhere_gets_filled(self):
        con = _make_db()
        _add_authoritative(con, 'MISSEDCO', 'bonus', '2024-06-01', 0.5, '1:1')
        res = oa.cross_validate_with_mc_actions(con, persist=True)
        assert len(res['filled']) == 1
        row = con.execute(
            "SELECT ex_date, factor, source FROM ohlcv_adjustment_factors WHERE symbol='MISSEDCO'"
        ).fetchone()
        assert row == ('2024-06-01', 0.5, 'mc_corporate_action')

    def test_persist_false_reports_but_does_not_write(self):
        con = _make_db()
        _add_authoritative(con, 'MISSEDCO', 'split', '2024-06-01', 0.2)
        res = oa.cross_validate_with_mc_actions(con, persist=False)
        assert len(res['filled']) == 1
        count = con.execute("SELECT COUNT(*) FROM ohlcv_adjustment_factors").fetchone()[0]
        assert count == 0

    def test_filled_insert_does_not_clobber_an_unrelated_existing_row(self):
        """A different symbol's existing heuristic row must survive untouched."""
        con = _make_db()
        _add_heuristic(con, 'OTHERCO', '2024-01-01', 0.5)
        _add_authoritative(con, 'MISSEDCO', 'split', '2024-06-01', 0.2)
        oa.cross_validate_with_mc_actions(con, persist=True)
        row = con.execute("SELECT factor FROM ohlcv_adjustment_factors WHERE symbol='OTHERCO'").fetchone()
        assert row[0] == 0.5


class TestDisagreement:
    def test_mismatched_factor_in_window_is_disagreement_not_overwritten_either_way(self):
        con = _make_db()
        _add_heuristic(con, 'BADCO', '2024-01-05', 0.5)     # heuristic thinks 1:1 bonus
        _add_authoritative(con, 'BADCO', 'split', '2024-01-05', 0.1, '10:1')  # authoritative says 1:10
        res = oa.cross_validate_with_mc_actions(con, persist=True)
        assert len(res['disagreement']) == 1
        assert res['filled'] == [], "a disagreement must never be silently 'filled' as a second row"
        # NEITHER value was touched -- this is the load-bearing guarantee: overwriting risks
        # double-adjusting a bar the heuristic's own factor was already correctly applied to.
        row = con.execute(
            "SELECT factor, source FROM ohlcv_adjustment_factors WHERE symbol='BADCO'"
        ).fetchone()
        assert row == (0.5, 'bhavcopy_prev_close')
        count = con.execute("SELECT COUNT(*) FROM ohlcv_adjustment_factors WHERE symbol='BADCO'").fetchone()[0]
        assert count == 1, "disagreement must not add a second competing row for the same symbol"


class TestScopeGuards:
    def test_dividend_and_rights_events_are_ignored_entirely(self):
        """ratio_factor is NULL for dividend/rights by construction (mc_corporate_actions_
        fetcher.py never computes one) -- the WHERE clause must exclude them, not crash on a
        NULL comparison."""
        con = _make_db()
        _add_authoritative(con, 'DIVCO', 'dividend', '2024-01-01', None, None)
        res = oa.cross_validate_with_mc_actions(con)
        assert res == {'confirmed': [], 'filled': [], 'disagreement': []}

    def test_far_apart_dates_are_not_matched(self):
        con = _make_db()
        _add_heuristic(con, 'FARCO', '2024-01-01', 0.5)
        _add_authoritative(con, 'FARCO', 'bonus', '2024-03-01', 0.5)  # >5 days apart
        res = oa.cross_validate_with_mc_actions(con)
        assert len(res['filled']) == 1
        assert res['confirmed'] == []
