"""Regression tests for Finding #47 (2026-07-28 full-stack audit): simulate_trades() used
to exclude a symbol from the ENTIRE backtest window via a blanket join against nse_stocks'
LIVE (today's) is_asm/gsm_stage flag -- a stock currently under surveillance had its whole
multi-year trade history wiped from the backtest (reverse-survivorship bias), while a
now-clean stock's historically-restricted period was never excluded. Fixed to a true
point-in-time filter using each signal's own technical_signals row (asm_flag/gsm_stage as
of the exact date it fired), loaded in load_signals() and passed straight through --
_load_surveillance_symbols() (the old DB-querying method) was removed entirely.
"""
import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.backtester import Backtester


def _bt() -> Backtester:
    return Backtester.__new__(Backtester)


def _signal_row(symbol, signal_date, asm_flag=None, gsm_stage=None):
    return {
        'symbol': symbol,
        'signal_date': pd.Timestamp(signal_date),
        'signal_score': 5,
        'entry_price_ref': 100.0,
        'stop_loss': 90.0,
        'target_price': None,
        'signals_json': '[]',
        'nifty_regime': 'BULL',
        'adx': 25.0,
        'horizon_days': 15,
        'asm_flag': asm_flag,
        'gsm_stage': gsm_stage,
    }


def _ohlcv(symbol):
    return {symbol: pd.DataFrame({
        'symbol': symbol,
        'date':   pd.to_datetime(['2024-01-01', '2024-01-02', '2024-01-20']),
        'open':   [100.0, 102.0, 110.0],
        'high':   [105.0, 106.0, 115.0],
        'low':    [98.0,  100.0, 108.0],
        'close':  [104.0, 103.0, 112.0],
        'volume': [1_000_000] * 3,
    })}


class TestPointInTimeSurveillanceFilter:
    def test_signal_flagged_asm_that_day_is_excluded(self):
        bt = _bt()
        signals = pd.DataFrame([_signal_row('AAPL', '2024-01-01', asm_flag=1)])
        trade_log, _ = bt.simulate_trades(
            signals, _ohlcv('AAPL'), max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        assert trade_log == []

    def test_signal_flagged_gsm_that_day_is_excluded(self):
        bt = _bt()
        signals = pd.DataFrame([_signal_row('AAPL', '2024-01-01', gsm_stage=2)])
        trade_log, _ = bt.simulate_trades(
            signals, _ohlcv('AAPL'), max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        assert trade_log == []

    def test_signal_not_flagged_that_day_is_included_even_if_symbol_is_flagged_elsewhere(self):
        """The core bug: a symbol under surveillance on ONE date must not blanket-exclude
        its signals on OTHER dates. Two signals for the same symbol, only one flagged."""
        bt = _bt()
        signals = pd.DataFrame([
            _signal_row('AAPL', '2024-01-01', asm_flag=0, gsm_stage=0),
        ])
        trade_log, _ = bt.simulate_trades(
            signals, _ohlcv('AAPL'), max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        assert len(trade_log) == 1, "an unflagged signal must not be excluded just because the symbol is flagged on other dates"

    def test_unknown_historical_flag_null_is_not_excluded(self):
        """A historical date predating the point-in-time snapshot has asm_flag=NULL (not
        backfillable). NULL must mean 'unknown, don't exclude' -- not 'exclude to be safe'
        (that would just reintroduce a different flavor of the same bias) and not crash."""
        bt = _bt()
        signals = pd.DataFrame([_signal_row('AAPL', '2024-01-01', asm_flag=None, gsm_stage=None)])
        trade_log, _ = bt.simulate_trades(
            signals, _ohlcv('AAPL'), max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        assert len(trade_log) == 1

    def test_missing_columns_entirely_does_not_crash_and_filters_nothing(self):
        """Callers that don't pass asm_flag/gsm_stage at all (e.g. older test fixtures)
        must not crash -- the filter is a no-op when the columns aren't present."""
        bt = _bt()
        signals = pd.DataFrame([{
            'symbol': 'AAPL', 'signal_date': pd.Timestamp('2024-01-01'), 'signal_score': 5,
            'entry_price_ref': 100.0, 'stop_loss': 90.0, 'target_price': None,
            'signals_json': '[]', 'nifty_regime': 'BULL', 'adx': 25.0, 'horizon_days': 15,
        }])
        trade_log, _ = bt.simulate_trades(
            signals, _ohlcv('AAPL'), max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        assert len(trade_log) == 1

    def test_backtester_has_no_db_dependent_surveillance_method_left(self):
        assert not hasattr(Backtester, '_load_surveillance_symbols')
