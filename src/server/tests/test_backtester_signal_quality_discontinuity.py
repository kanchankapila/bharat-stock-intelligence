"""Regression test for warn_on_signal_quality_discontinuity() (2026-08-10): backtester.py
replays technical_signals.win_probability/stop_loss/targets as-written, so a --start window
spanning a scoring-logic change silently blends signal quality from two different code eras
into one performance number. No single "the fix landed on date X" cutoff is clean enough to
hardcode as a default --start floor -- flag the discontinuity from the loaded data instead.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.backtester import warn_on_signal_quality_discontinuity


def _frame(dates, win_probs):
    return pd.DataFrame({
        'signal_date': pd.to_datetime(dates),
        'win_probability': win_probs,
    })


def test_flags_a_large_quarterly_swing():
    df = _frame(
        ['2023-01-15', '2023-02-15', '2026-07-15', '2026-08-15'],
        [0.20, 0.22, 0.55, 0.58],
    )
    msg = warn_on_signal_quality_discontinuity(df)
    assert msg is not None
    assert 'scoring-logic change' in msg


def test_stable_window_is_not_flagged():
    df = _frame(
        ['2026-06-01', '2026-06-15', '2026-07-01', '2026-07-15'],
        [0.40, 0.41, 0.39, 0.42],
    )
    assert warn_on_signal_quality_discontinuity(df) is None


def test_single_quarter_window_is_not_flagged():
    # Nothing to compare against -- one quarter can't be "discontinuous" with itself.
    df = _frame(['2026-07-01', '2026-07-15'], [0.20, 0.90])
    assert warn_on_signal_quality_discontinuity(df) is None


def test_empty_frame_is_a_noop():
    assert warn_on_signal_quality_discontinuity(pd.DataFrame()) is None


def test_missing_win_probability_column_is_a_noop():
    df = pd.DataFrame({'signal_date': pd.to_datetime(['2026-07-01'])})
    assert warn_on_signal_quality_discontinuity(df) is None
