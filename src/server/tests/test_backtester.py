import math
import sys
import os
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.backtester import Backtester, INITIAL_CAPITAL


def _make_signals(symbol='AAPL', signal_date='2024-01-01', stop_loss=90.0):
    return pd.DataFrame([{
        'symbol': symbol,
        'signal_date': pd.Timestamp(signal_date),
        'signal_score': 5,
        'entry_price_ref': 100.0,
        'stop_loss': stop_loss,
        'signals_json': '[]',
        'nifty_regime': 'BULL',
        'adx': 25.0,
        'horizon_days': 15,
    }])


def _make_ohlcv(symbol='AAPL', dates=None, opens=None, highs=None, lows=None, closes=None):
    dates  = dates  or ['2024-01-01', '2024-01-02', '2024-01-20']
    opens  = opens  or [100.0, 102.0, 110.0]
    highs  = highs  or [105.0, 106.0, 115.0]
    lows   = lows   or [98.0,  100.0, 108.0]
    closes = closes or [104.0, 103.0, 112.0]
    df = pd.DataFrame({
        'symbol': symbol,
        'date':   pd.to_datetime(dates),
        'open':   opens,
        'high':   highs,
        'low':    lows,
        'close':  closes,
        'volume': [1_000_000] * len(dates),
    })
    return {symbol: df}


class TestPositionSizing:
    """Position size must be initial_capital / max_positions, not cash / remaining_slots."""

    def test_fixed_fraction_of_initial_capital(self):
        bt = Backtester(db_path=':memory:')
        signals = _make_signals()
        ohlcv = _make_ohlcv()
        max_pos = 10
        capital = 1_000_000.0

        trade_log, _ = bt.simulate_trades(
            signals, ohlcv, max_positions=max_pos, initial_capital=capital,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        assert len(trade_log) == 1
        trade = trade_log[0]
        # entry is next-day open = 102.0; target allocation = 100_000
        expected_shares = math.floor(100_000.0 / 102.0)  # = 980
        # Allow ±1 share for rounding
        assert abs(trade['shares'] - expected_shares) <= 1

    def test_position_size_not_dependent_on_depleted_cash(self):
        """Open 5 positions; the 6th should still get initial_capital/max_positions allocation."""
        signals_rows = []
        ohlcv_dict = {}
        max_pos = 10
        capital = 1_000_000.0

        for i in range(6):
            sym = f'SYM{i}'
            signals_rows.append({
                'symbol': sym,
                'signal_date': pd.Timestamp('2024-01-01'),
                'signal_score': 5,
                'entry_price_ref': 100.0,
                'stop_loss': 90.0,
                'signals_json': '[]',
                'nifty_regime': 'BULL',
                'adx': 25.0,
                'horizon_days': 30,
            })
            ohlcv_dict[sym] = pd.DataFrame({
                'symbol': sym,
                'date':   pd.to_datetime(['2024-01-01', '2024-01-02', '2024-02-15']),
                'open':   [100.0, 100.0, 105.0],
                'high':   [105.0, 105.0, 110.0],
                'low':    [95.0,  95.0,  100.0],
                'close':  [104.0, 104.0, 108.0],
                'volume': [1_000_000, 1_000_000, 1_000_000],
            })

        signals = pd.DataFrame(signals_rows)
        bt = Backtester(db_path=':memory:')
        trade_log, _ = bt.simulate_trades(
            signals, ohlcv_dict, max_positions=max_pos, initial_capital=capital,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        shares_list = [t['shares'] for t in trade_log]
        # All allocations should be equal (same target capital, same entry price)
        assert len(set(shares_list)) == 1, f"Unequal position sizes: {shares_list}"


class TestGapDownStop:
    """When a stock opens below the stop-loss, fill at open (not the SL price)."""

    def test_stop_triggered_at_exact_sl(self):
        """Intraday low hits SL but open is above SL — fill at SL."""
        bt = Backtester(db_path=':memory:')
        signals = _make_signals(stop_loss=95.0)
        ohlcv = _make_ohlcv(
            dates=['2024-01-01', '2024-01-02', '2024-01-03'],
            opens=[100.0, 97.0,  97.0],   # open above SL on day 2
            highs=[105.0, 98.0,  98.0],
            lows= [98.0,  94.0,  94.0],   # low dips below SL on day 2
            closes=[104.0, 96.0, 96.0],
        )
        trade_log, _ = bt.simulate_trades(
            signals, ohlcv, max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        stop_trades = [t for t in trade_log if t['outcome'] == 'STOP_LOSS']
        assert len(stop_trades) == 1
        assert stop_trades[0]['exit_price'] == pytest.approx(95.0, abs=0.01)

    def test_gap_down_stop_fills_at_open(self):
        """Stock gaps down below SL overnight — fill at open, not SL price."""
        bt = Backtester(db_path=':memory:')
        signals = _make_signals(stop_loss=95.0)
        ohlcv = _make_ohlcv(
            dates=['2024-01-01', '2024-01-02', '2024-01-03'],
            opens=[100.0, 88.0,  88.0],   # gap-down open at 88 (below SL of 95)
            highs=[105.0, 90.0,  90.0],
            lows= [98.0,  86.0,  86.0],
            closes=[104.0, 89.0, 89.0],
        )
        trade_log, _ = bt.simulate_trades(
            signals, ohlcv, max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        stop_trades = [t for t in trade_log if t['outcome'] == 'STOP_LOSS']
        assert len(stop_trades) == 1
        # Must fill at 88 (open), NOT at 95 (stop price)
        assert stop_trades[0]['exit_price'] == pytest.approx(88.0, abs=0.01)


class TestCommission:
    """Commission is deducted on both entry and exit; PnL reflects it."""

    def test_commission_reduces_net_pnl(self):
        bt_no_comm  = Backtester(db_path=':memory:')
        bt_with_comm = Backtester(db_path=':memory:')
        signals  = _make_signals()
        ohlcv    = _make_ohlcv()

        log_no_comm, _  = bt_no_comm.simulate_trades(
            signals, ohlcv, max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=0,
        )
        log_with_comm, _ = bt_with_comm.simulate_trades(
            signals, ohlcv, max_positions=10, initial_capital=1_000_000,
            slippage_bps=0, stop_loss_pct=7.0, commission_bps=25,
        )
        assert log_no_comm, "Expected at least one trade"
        assert log_with_comm, "Expected at least one trade"
        # Net PnL with commission must be strictly less than without
        assert log_with_comm[0]['pnl'] < log_no_comm[0]['pnl']
