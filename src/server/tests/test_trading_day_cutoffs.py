"""
Pins that the engine/scoring cutoffs use TRADING days, not calendar days.

Negative control for AF-20260823-70/74/75/76. The bug these guard is invisible to every
freshness monitor: `deep_learning_predictions` was perfectly fresh the whole time
`_get_dl_scores` was returning {} on Mondays, because the defect is in the READER's date
arithmetic. Measured live: `dl_score` was 0 on 100% of rows for 5 of the last 8 Mondays
(2,163/2,163 on 2026-08-17), and `scoring_engine`'s `win_prob_map` was empty on a real Sunday
run, dropping Factor 3 from a measured mean of 17.71/20 to its `8  # neutral` fallback.

Source-level rather than DB-level on purpose: the bug only manifests when today's weekday makes
the window miss a session, so a DB test would pass on a Tuesday and fail on a Monday. Asserting
the call shape is deterministic and is what actually regressed.
"""

import ast
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import as_of  # noqa: E402

SERVER = Path(__file__).resolve().parents[1]

# file -> the cutoff-assigning variables that must be trading-day anchored.
GUARDED = {
    "unified_ranker.py": 6,          # 6 engine getters, days=1/2/3
    "scoring_engine.py": 2,          # win_prob_map (days=1), sym_signal_types (days=3)
    "screener_sector_rotation.py": 1,  # primary technical_signals read (days=2)
}


def _src(name: str) -> str:
    return (SERVER / name).read_text(encoding="utf-8")


class TestNoShortCalendarCutoffs:
    @pytest.mark.parametrize("name", sorted(GUARDED))
    def test_no_short_calendar_lookback_survives(self, name):
        """No `date.today() - timedelta(days=N)` for N<=4 without an explicit exemption.

        Reuses the shipped static check rather than reimplementing its logic -- a test that
        rewrites the rule passes against unfixed source (recurring-bugs.md)."""
        sys.path.insert(0, str(SERVER.parents[1] / "scripts"))
        import check_recurring_bugs as crb

        path = SERVER / name
        assert crb.check_short_calendar_lookback(path, _src(name)) == []

    @pytest.mark.parametrize("name,expected", sorted(GUARDED.items()))
    def test_uses_trading_days_back(self, name, expected):
        """The replacements are actually present -- deleting a cutoff line entirely would
        satisfy the check above while removing the filter altogether."""
        found = len(re.findall(r"as_of\.trading_days_back\(", _src(name)))
        assert found >= expected, f"{name}: expected >={expected} trading_days_back calls, got {found}"

    @pytest.mark.parametrize("name", sorted(GUARDED))
    def test_as_of_is_imported(self, name):
        tree = ast.parse(_src(name))
        imported = any(
            (isinstance(n, ast.Import) and any(a.name == "as_of" for a in n.names))
            for n in ast.walk(tree)
        )
        assert imported, f"{name} calls as_of.trading_days_back but never imports as_of"


class TestTradingDaysBackContract:
    """The one property every call site depends on: [-1] is the OLDEST of the n sessions, so
    `>= that` admits exactly n trading days regardless of weekends or holidays."""

    def test_returns_n_descending_dates(self):
        days = as_of.trading_days_back(3)
        assert len(days) == 3
        assert days == sorted(days, reverse=True), "must be newest-first; [-1] is the cutoff"

    def test_cutoff_never_lands_in_the_future(self):
        import datetime

        assert as_of.trading_days_back(1)[-1] <= datetime.date.today()

    def test_zero_is_empty_not_an_error(self):
        assert as_of.trading_days_back(0) == []
