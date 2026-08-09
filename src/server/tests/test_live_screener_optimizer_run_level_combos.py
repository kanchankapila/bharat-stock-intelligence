"""Regression test for the 2026-08-07 train/serve-skew fix in live_screener_optimizer.py.

Sibling bug to live_screener_ml_ranker.py's fix, found by the same investigation the same
day (see live_screener_ml_no_live_edge_2026_08_07 memory) -- but this one is user-facing, not
just an internal model quality issue.

_optimize_for_horizon() used to group live_screener_outcomes rows by (appeared_at, symbol) --
calendar DAY -- so a "combination" (e.g. RSI_OVERSOLD + VOLUME_SURGE) counted as a match
whenever a stock matched EACH filter at ANY point that day, even hours apart. But
LiveMarketScreener.tsx's "Apply Combo" / "AI Recommendation" button
(applyCombo -> getLiveMarketScreener -> fetchLiveMarketScreener) sends every selected filter
as ONE simultaneous-AND query to NiftyTrader's live-market-filter-data endpoint -- it only
ever returns stocks matching ALL selected filters AT THE SAME MOMENT, in the current scan.

So the win_rate/avg_return badge shown next to a clickable "AI Recommendation" (a specific
numeric claim, e.g. "68% win rate, n=45") was computed over a population that "Apply" then
does NOT reproduce -- a materially easier-to-satisfy day-level-union condition standing in for
a much rarer same-scan-simultaneous condition.

Fixed by grouping by (run_id, symbol) instead, so a "combination" match means "matched within
the SAME scan cycle" -- exactly what fetchLiveMarketScreener's simultaneous-AND query draws
from.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import live_screener_optimizer as lso


def _multi_run_day_frame():
    """One trading day, one symbol, matched by two different filters across three distinct
    scan cycles (run_id 1/2/3) -- never simultaneously in the SAME run except run_id=2.
    Positive return_3d/return_intraday so a naive day-level union would happily report both
    RSI_OVERSOLD and VOLUME_SURGE as part of a winning "combination", even though they were
    never actually observed matching together in a single live query except at run_id=2."""
    return pd.DataFrame([
        {"symbol": "TESTCO", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
         "run_id": 1, "return_1d": 0.01, "return_3d": 0.02, "return_5d": 0.03, "return_intraday": 0.01},
        {"symbol": "TESTCO", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
         "run_id": 2, "return_1d": 0.01, "return_3d": 0.02, "return_5d": 0.03, "return_intraday": 0.02},
        {"symbol": "TESTCO", "filter_key": "VOLUME_SURGE", "appeared_at": "2026-06-01",
         "run_id": 2, "return_1d": 0.01, "return_3d": 0.02, "return_5d": 0.03, "return_intraday": 0.02},
        {"symbol": "TESTCO", "filter_key": "VOLUME_SURGE", "appeared_at": "2026-06-01",
         "run_id": 3, "return_1d": 0.01, "return_3d": 0.02, "return_5d": 0.03, "return_intraday": -0.01},
    ])


class TestOptimizeForHorizonGroupsByRunNotDay:
    """Every test here calls lso._build_run_matrix directly -- the REAL function the source
    file uses -- rather than reimplementing the grouping logic locally, so a regression in
    the actual source is what these tests catch."""

    def test_one_row_per_run_not_one_row_per_day(self):
        """The old (appeared_at, symbol) grouping would collapse all 3 runs into a single
        row for TESTCO on 2026-06-01. The fix must keep them separate."""
        matrix, _ = lso._build_run_matrix(_multi_run_day_frame())
        assert len(matrix) == 3, (
            f"expected one row per (run_id, symbol) -- got {len(matrix)}, meaning runs are "
            "still being collapsed by day"
        )

    def test_filter_flags_reflect_only_this_runs_matches(self):
        """run_id=1 matched only RSI_OVERSOLD; run_id=3 matched only VOLUME_SURGE. The old
        day-level union would have set BOTH flags to 1 for every run that day, since the
        symbol matched both filters at SOME point -- exactly the mismatch against
        fetchLiveMarketScreener's simultaneous-AND live query that this fix closes."""
        matrix, _ = lso._build_run_matrix(_multi_run_day_frame())
        by_run = matrix.set_index("run_id")

        assert by_run.loc[1, "RSI_OVERSOLD"] == 1
        assert by_run.loc[1, "VOLUME_SURGE"] == 0, (
            "run_id=1 never matched VOLUME_SURGE -- must not show matched just because the "
            "symbol matched it LATER the same day"
        )
        assert by_run.loc[3, "VOLUME_SURGE"] == 1
        assert by_run.loc[3, "RSI_OVERSOLD"] == 0, (
            "run_id=3 no longer matched RSI_OVERSOLD -- must not show matched just because "
            "the symbol matched it EARLIER the same day"
        )

    def test_only_run_id_2_represents_a_genuine_simultaneous_combo(self):
        """The RSI_OVERSOLD + VOLUME_SURGE 'combination' only genuinely co-occurred within a
        single scan at run_id=2 -- this is the only row where a simultaneous-AND live query
        for both filters would actually return TESTCO."""
        matrix, _ = lso._build_run_matrix(_multi_run_day_frame())
        both_matched = matrix[(matrix["RSI_OVERSOLD"] == 1) & (matrix["VOLUME_SURGE"] == 1)]
        assert len(both_matched) == 1
        assert both_matched.iloc[0]["run_id"] == 2

    def test_filter_cols_excludes_run_id_not_appeared_at(self):
        """filter_cols must exclude the new (run_id, symbol) index columns -- a stale
        exclusion list still keyed on 'appeared_at' would leave run_id in the feature/rule
        space, silently letting the decision tree split on an arbitrary integer ID."""
        _, filter_cols = lso._build_run_matrix(_multi_run_day_frame())
        assert "run_id" not in filter_cols
        assert set(filter_cols) == {"RSI_OVERSOLD", "VOLUME_SURGE"}

    def test_optimize_combinations_query_joins_appearances_for_run_id(self):
        """optimize_combinations()'s SQL must join live_screener_appearances to obtain
        run_id -- live_screener_outcomes alone has no run_id column."""
        import inspect
        src = inspect.getsource(lso.optimize_combinations)
        assert "a.run_id" in src
        assert "JOIN live_screener_appearances" in src
