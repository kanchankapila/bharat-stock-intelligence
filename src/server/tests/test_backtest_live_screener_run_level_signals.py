"""Regression test for the 2026-08-07 train/serve-skew fix in backtest_live_screener.py.

Third instance of the same bug found this day (see live_screener_ml_no_live_edge_2026_08_07
memory for the first two: live_screener_ml_ranker.py and live_screener_optimizer.py). This
one is the auto-scheduled backtest engine (sync.jobs.ts -> `--auto-backtest-top`, both swing
and intraday) that feeds `backtesting_runs`, which LiveMarketScreener.tsx's
`findBacktestForCombo` surfaces directly next to the "AI Recommendation" combos.

_generate_combo_signals() used to group live_screener_outcomes by (appeared_at, symbol) --
calendar DAY -- so "ALL of the specified filters active" meant "matched each filter at SOME
point that day, even hours apart" rather than "matched simultaneously in one scan", which is
what the frontend's "Apply Combo" button actually queries for live (one simultaneous-AND
request to NiftyTrader). Fixed by grouping by (run_id, symbol) instead.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import backtest_live_screener as bls


def _cross_day_never_simultaneous_frame():
    """Symbol A matches RSI_OVERSOLD at run_id=1 and VOLUME_SURGE at run_id=2 -- same day,
    never the same run. Symbol B matches BOTH filters within the SAME run_id=3 (a different
    day). Only B represents a genuine simultaneous-AND match."""
    return pd.DataFrame([
        {"symbol": "SYMA", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
         "run_id": 1, "entry_price": 100.0, "return_1d": 0.01, "return_3d": 0.02,
         "return_5d": 0.03, "return_intraday": 0.01},
        {"symbol": "SYMA", "filter_key": "VOLUME_SURGE", "appeared_at": "2026-06-01",
         "run_id": 2, "entry_price": 105.0, "return_1d": 0.01, "return_3d": 0.02,
         "return_5d": 0.03, "return_intraday": 0.02},
        {"symbol": "SYMB", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-02",
         "run_id": 3, "entry_price": 50.0, "return_1d": 0.04, "return_3d": 0.05,
         "return_5d": 0.06, "return_intraday": 0.04},
        {"symbol": "SYMB", "filter_key": "VOLUME_SURGE", "appeared_at": "2026-06-02",
         "run_id": 3, "entry_price": 50.0, "return_1d": 0.04, "return_3d": 0.05,
         "return_5d": 0.06, "return_intraday": 0.04},
    ])


class TestGenerateComboSignalsRunLevel:
    def test_only_the_genuinely_simultaneous_match_produces_a_signal(self):
        """SYMA never matched both filters in the same run -- must NOT produce a signal
        (the exact day-level-union artifact this fix removes). SYMB did -- must."""
        df = _cross_day_never_simultaneous_frame()
        signals = bls._generate_combo_signals(df, ["RSI_OVERSOLD", "VOLUME_SURGE"], "return_3d")
        assert list(signals["symbol"]) == ["SYMB"], (
            f"expected only SYMB (genuine same-run match) -- got {list(signals['symbol'])}. "
            "SYMA matched each filter on the same day but never in the same run, and must be "
            "excluded."
        )

    def test_signal_entry_price_comes_from_the_matching_run(self):
        df = _cross_day_never_simultaneous_frame()
        signals = bls._generate_combo_signals(df, ["RSI_OVERSOLD", "VOLUME_SURGE"], "return_3d")
        assert signals.iloc[0]["entry_price"] == 50.0
        assert signals.iloc[0]["return_val"] == 0.05

    def test_empty_result_has_expected_columns_not_a_crash(self):
        """No symbol matches all filters simultaneously -- must return an empty frame with the
        columns run_backtest expects (.empty check + 'appeared_at' access), not raise."""
        df = pd.DataFrame([
            {"symbol": "SYMA", "filter_key": "RSI_OVERSOLD", "appeared_at": "2026-06-01",
             "run_id": 1, "entry_price": 100.0, "return_1d": 0.01, "return_3d": 0.02,
             "return_5d": 0.03, "return_intraday": 0.01},
        ])
        signals = bls._generate_combo_signals(df, ["RSI_OVERSOLD", "VOLUME_SURGE"], "return_3d")
        assert signals.empty
        assert list(signals.columns) == ["symbol", "appeared_at", "entry_price", "return_val"]

    def test_start_end_date_bounds_still_apply(self):
        df = _cross_day_never_simultaneous_frame()
        signals = bls._generate_combo_signals(
            df, ["RSI_OVERSOLD", "VOLUME_SURGE"], "return_3d",
            start_date="2026-06-03", end_date="2026-06-30",
        )
        assert signals.empty, "SYMB's 2026-06-02 signal should be excluded by start_date=2026-06-03"

    def test_query_joins_appearances_for_run_id(self):
        """run_backtest()'s SQL must join live_screener_appearances to obtain run_id --
        live_screener_outcomes alone has no run_id column."""
        import inspect
        src = inspect.getsource(bls.run_backtest)
        assert "a.run_id" in src
        assert "JOIN live_screener_appearances" in src
