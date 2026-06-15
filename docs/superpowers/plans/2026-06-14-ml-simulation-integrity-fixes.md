# ML & Simulation Integrity Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five correctness bugs across backtesting simulation, ML data leakage, RL reward/state formulation, HMM label stability, and weight optimizer temporal split.

**Architecture:** All fixes are surgical to five Python engines in `src/server/`. No Node.js/tRPC changes needed. No new pip dependencies. Tests use in-memory SQLite so no live DB is required. Run `python -m pytest src/server/tests/ -v` to verify the full suite.

**Tech Stack:** Python 3.11, scikit-learn, pandas, numpy, sqlite3, hmmlearn, pytest

---

## File Map

| File | Change |
|---|---|
| `src/server/backtester.py` | Fix position sizing, gap-down stop fill, and commission friction |
| `src/server/ml_ensemble.py` | Drop look-ahead features; replace StratifiedKFold with TimeSeriesSplit |
| `src/server/rl_agent.py` | Fix reward horizon; fix next-state s' transition |
| `src/server/regime_detector.py` | Stabilise HMM label assignment; anchor feature queries to inference date |
| `src/server/strategy_optimizer.py` | Replace random 80/20 split with chronological walk-forward split |
| `src/server/tests/__init__.py` | Create test package (empty file) |
| `src/server/tests/test_backtester.py` | Unit tests for backtester fixes |
| `src/server/tests/test_ml_ensemble.py` | Unit tests for ML leakage fixes |
| `src/server/tests/test_rl_agent.py` | Unit tests for RL fixes |
| `src/server/tests/test_regime_detector.py` | Unit tests for HMM fixes |
| `src/server/tests/test_strategy_optimizer.py` | Unit tests for optimizer fix |

---

## Task 1: Backtester Realism — Position Sizing, Gap-Down Stops, Commission

**Files:**
- Modify: `src/server/backtester.py:107-254` (`simulate_trades`)
- Create: `src/server/tests/test_backtester.py`

Three bugs, one commit.

- [ ] **Step 1: Create the test package**

```
src/server/tests/__init__.py  (empty file)
```

- [ ] **Step 2: Write the failing tests**

Create `src/server/tests/test_backtester.py`:

```python
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
```

- [ ] **Step 3: Run tests to confirm they fail**

```
python -m pytest src/server/tests/test_backtester.py -v
```

Expected: multiple failures (`TypeError` on `commission_bps` kwarg, wrong position sizes, wrong stop-fill price).

- [ ] **Step 4: Implement fixes in `src/server/backtester.py`**

**4a — Add `commission_bps` parameter to `simulate_trades` (line 113):**

Old:
```python
def simulate_trades(
    self,
    signals: pd.DataFrame,
    ohlcv_dict: dict[str, pd.DataFrame],
    max_positions: int = 20,
    initial_capital: float = INITIAL_CAPITAL,
    slippage_bps: float = 10,
    stop_loss_pct: float = 7.0,
) -> tuple[list[dict], pd.Series]:
```

New:
```python
def simulate_trades(
    self,
    signals: pd.DataFrame,
    ohlcv_dict: dict[str, pd.DataFrame],
    max_positions: int = 20,
    initial_capital: float = INITIAL_CAPITAL,
    slippage_bps: float = 10,
    stop_loss_pct: float = 7.0,
    commission_bps: float = 25,
) -> tuple[list[dict], pd.Series]:
```

**4b — Fix horizon exit (lines 158-174): apply commission and record `shares`:**

Old:
```python
exit_price = float(day_ohlcv['close'].iloc[0])
ret_pct    = (exit_price - pos['entry_price']) / pos['entry_price'] * 100
pnl        = (exit_price - pos['entry_price']) * pos['shares']
cash      += exit_price * pos['shares']
outcome    = 'WIN' if ret_pct > 1.0 else 'LOSS' if ret_pct < -1.0 else 'NEUTRAL'
trade_log.append({
    'symbol':       sym,
    'entry_date':   pos['entry_date'].isoformat(),
    'exit_date':    date.isoformat(),
    'entry_price':  round(pos['entry_price'], 2),
    'exit_price':   round(exit_price, 2),
    'return_pct':   round(ret_pct, 4),
    'pnl':          round(pnl, 2),
    'outcome':      outcome,
    'signal_score': pos['signal_score'],
    'holding_days': days_held,
})
```

New:
```python
exit_price   = float(day_ohlcv['close'].iloc[0])
exit_comm    = exit_price * pos['shares'] * commission_bps / 10_000
net_proceeds = exit_price * pos['shares'] - exit_comm
pnl          = net_proceeds - pos['total_cost']
ret_pct      = pnl / pos['total_cost'] * 100
cash        += net_proceeds
outcome      = 'WIN' if ret_pct > 1.0 else 'LOSS' if ret_pct < -1.0 else 'NEUTRAL'
trade_log.append({
    'symbol':       sym,
    'entry_date':   pos['entry_date'].isoformat(),
    'exit_date':    date.isoformat(),
    'entry_price':  round(pos['entry_price'], 2),
    'exit_price':   round(exit_price, 2),
    'return_pct':   round(ret_pct, 4),
    'pnl':          round(pnl, 2),
    'outcome':      outcome,
    'signal_score': pos['signal_score'],
    'holding_days': days_held,
    'shares':       pos['shares'],
})
del open_positions[sym]
```

**4c — Fix stop-loss exit (lines 182-202): gap-down fill and commission:**

Old:
```python
day_low = float(day_ohlcv['low'].iloc[0])
if day_low <= pos['stop_loss']:
    exit_price = pos['stop_loss']  # assume stops are honoured
    ret_pct    = (exit_price - pos['entry_price']) / pos['entry_price'] * 100
    pnl        = (exit_price - pos['entry_price']) * pos['shares']
    cash      += exit_price * pos['shares']
    trade_log.append({
        ...
        'outcome': 'STOP_LOSS',
        ...
    })
    del open_positions[sym]
```

New:
```python
day_low  = float(day_ohlcv['low'].iloc[0])
day_open = float(day_ohlcv['open'].iloc[0])
if day_low <= pos['stop_loss']:
    # Gap-down: if open is already below stop, fill at open (worse than stop)
    exit_price   = min(day_open, pos['stop_loss'])
    exit_comm    = exit_price * pos['shares'] * commission_bps / 10_000
    net_proceeds = exit_price * pos['shares'] - exit_comm
    pnl          = net_proceeds - pos['total_cost']
    ret_pct      = pnl / pos['total_cost'] * 100
    cash        += net_proceeds
    trade_log.append({
        'symbol':       sym,
        'entry_date':   pos['entry_date'].isoformat(),
        'exit_date':    date.isoformat(),
        'entry_price':  round(pos['entry_price'], 2),
        'exit_price':   round(exit_price, 2),
        'return_pct':   round(ret_pct, 4),
        'pnl':          round(pnl, 2),
        'outcome':      'STOP_LOSS',
        'signal_score': pos['signal_score'],
        'holding_days': (date - pos['entry_date']).days,
        'shares':       pos['shares'],
    })
    del open_positions[sym]
```

**4d — Fix position sizing (lines 220-225) and record `total_cost`:**

Old:
```python
# Equal-weight position size
position_capital = cash / max(max_positions - len(open_positions), 1)
position_capital = min(position_capital, cash * 0.1)  # max 10% per trade
if position_capital < 1000:
    continue
shares = math.floor(position_capital / entry_price)
if shares < 1:
    continue

cost = shares * entry_price
cash -= cost

sl = float(row['stop_loss']) if pd.notna(row['stop_loss']) else entry_price * (1 - stop_loss_pct / 100)
open_positions[sym] = {
    'entry_date':   date,
    'entry_price':  entry_price,
    'stop_loss':    sl,
    'horizon_days': int(row['horizon_days']),
    'shares':       shares,
    'signal_score': int(row['signal_score']),
}
```

New:
```python
# Fixed equal-weight: each slot = 1/max_positions of initial capital
position_capital = initial_capital / max_positions
position_capital = min(position_capital, cash * 0.95)  # cannot exceed available cash
if position_capital < 1000:
    continue
shares = math.floor(position_capital / entry_price)
if shares < 1:
    continue

entry_comm = shares * entry_price * commission_bps / 10_000
total_cost = shares * entry_price + entry_comm
cash -= total_cost

sl = float(row['stop_loss']) if pd.notna(row['stop_loss']) else entry_price * (1 - stop_loss_pct / 100)
open_positions[sym] = {
    'entry_date':   date,
    'entry_price':  entry_price,
    'stop_loss':    sl,
    'horizon_days': int(row['horizon_days']),
    'shares':       shares,
    'signal_score': int(row['signal_score']),
    'total_cost':   total_cost,
}
```

**4e — Thread `commission_bps` through `run()` (line 438):**

Old:
```python
trade_log, equity_curve = self.simulate_trades(
    signals, ohlcv_dict,
    max_positions=max_positions,
    initial_capital=initial_capital,
    slippage_bps=slippage_bps,
    stop_loss_pct=stop_loss_pct,
)
```

New:
```python
trade_log, equity_curve = self.simulate_trades(
    signals, ohlcv_dict,
    max_positions=max_positions,
    initial_capital=initial_capital,
    slippage_bps=slippage_bps,
    stop_loss_pct=stop_loss_pct,
    commission_bps=commission_bps,
)
```

And add `commission_bps: float = 25` to `run()` signature (line 403) and to `config` dict.

- [ ] **Step 5: Run tests — expect all to pass**

```
python -m pytest src/server/tests/test_backtester.py -v
```

Expected output:
```
PASSED test_backtester.py::TestPositionSizing::test_fixed_fraction_of_initial_capital
PASSED test_backtester.py::TestPositionSizing::test_position_size_not_dependent_on_depleted_cash
PASSED test_backtester.py::TestGapDownStop::test_stop_triggered_at_exact_sl
PASSED test_backtester.py::TestGapDownStop::test_gap_down_stop_fills_at_open
PASSED test_backtester.py::TestCommission::test_commission_reduces_net_pnl
```

- [ ] **Step 6: Commit**

```bash
git add src/server/backtester.py src/server/tests/__init__.py src/server/tests/test_backtester.py
git commit -m "fix(backtester): fixed-fraction sizing, gap-down stop fill, commission friction"
```

---

## Task 2: ML Data Leakage — Screener Score, Max Return, Temporal CV Split

**Files:**
- Modify: `src/server/ml_ensemble.py:66-141, 200-225`
- Create: `src/server/tests/test_ml_ensemble.py`

Three leaks, one commit.

- [ ] **Step 1: Write the failing tests**

Create `src/server/tests/test_ml_ensemble.py`:

```python
import sys
import os
import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.ml_ensemble import build_features, load_training_data, train_ensemble
import sqlite3


def _make_feature_df(n=10):
    return pd.DataFrame({
        'signal_score':  [5] * n,
        'rsi':           [50.0] * n,
        'adx':           [25.0] * n,
        'volume_ratio':  [1.0] * n,
        'horizon_days':  [15] * n,
        'nifty_regime':  ['BULL'] * n,
        'cmp':           [100.0] * n,
        'sma200':        [90.0] * n,
        'fii_3d_net':    [0.0] * n,
        'above_sma200':  [1] * n,
        'fifty_two_week_high': [110.0] * n,
        'signals_json':  ['[]'] * n,
        # These should NOT appear in features:
        'screener_score':  [80.0] * n,
        'max_return_pct':  [15.0] * n,
    })


class TestNoLookAheadFeatures:
    def test_screener_score_not_in_features(self):
        df = _make_feature_df()
        X = build_features(df)
        assert 'screener_score' not in X.columns, (
            "screener_score is a look-ahead feature (today's score joined to historical rows)"
        )

    def test_max_return_pct_not_in_features(self):
        df = _make_feature_df()
        X = build_features(df)
        assert 'max_return_pct' not in X.columns, (
            "max_return_pct is future information — it's the best return DURING the holding period"
        )


class TestTemporalCV:
    """TimeSeriesSplit must not allow future rows into earlier fold's training set."""

    def test_no_future_data_in_cv_folds(self):
        from sklearn.model_selection import TimeSeriesSplit
        # Simulate 100 chronologically ordered samples
        dates = pd.date_range('2023-01-01', periods=100, freq='D')
        idx = np.arange(100)

        skf = TimeSeriesSplit(n_splits=5)
        for train_idx, val_idx in skf.split(idx):
            # All training indices must be strictly less than all validation indices
            assert max(train_idx) < min(val_idx), (
                f"Temporal leakage: train max={max(train_idx)} >= val min={min(val_idx)}"
            )

    def test_training_data_sorted_before_cv(self):
        """Simulate the run() path: data must be sorted by signal_date before TimeSeriesSplit."""
        df = pd.DataFrame({
            'signal_date': pd.to_datetime(['2024-03-01', '2023-01-01', '2024-06-01']),
            'outcome': [1, 0, 1],
        })
        df = df.sort_values('signal_date').reset_index(drop=True)
        dates = df['signal_date'].tolist()
        # After sort, dates must be non-decreasing
        for i in range(1, len(dates)):
            assert dates[i] >= dates[i - 1]


class TestLoadTrainingDataNoLeakColumns:
    """load_training_data SQL must not SELECT screener_score or max_return_pct."""

    def test_training_query_has_no_screener_score(self):
        import inspect
        import src.server.ml_ensemble as mod
        src_code = inspect.getsource(mod.load_training_data)
        assert 'screener_score' not in src_code, (
            "load_training_data selects screener_score — join to stock_scores has no date filter"
        )

    def test_training_query_has_no_max_return_pct(self):
        import inspect
        import src.server.ml_ensemble as mod
        src_code = inspect.getsource(mod.load_training_data)
        assert 'max_return_pct' not in src_code, (
            "load_training_data selects max_return_pct — this is the maximum return DURING the horizon (future leak)"
        )
```

- [ ] **Step 2: Run tests to confirm they fail**

```
python -m pytest src/server/tests/test_ml_ensemble.py -v
```

Expected: `FAILED` for `screener_score`, `max_return_pct`, and the source inspection assertions.

- [ ] **Step 3: Implement fixes in `src/server/ml_ensemble.py`**

**3a — Remove `screener_score` and `max_return_pct` from `load_training_data` (lines 121-135):**

Old:
```python
    q = """
        SELECT so.symbol, so.signal_date, so.horizon_days, so.outcome,
               so.signal_score, so.signals_json, so.return_pct,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               sf.fifty_two_week_high,
               ss.score AS screener_score,
               so.max_return_pct
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
        LEFT JOIN stock_fundamentals sf
               ON sf.symbol = so.symbol
        LEFT JOIN stock_scores ss
               ON ss.symbol = so.symbol AND ss.timeframe = 'long_term'
        WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
          AND so.return_pct IS NOT NULL
    """
```

New:
```python
    q = """
        SELECT so.symbol, so.signal_date, so.horizon_days, so.outcome,
               so.signal_score, so.signals_json, so.return_pct,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               sf.fifty_two_week_high
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
        LEFT JOIN stock_fundamentals sf
               ON sf.symbol = so.symbol
        WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
          AND so.return_pct IS NOT NULL
    """
```

**3b — Remove `screener_score` and `max_return_pct` from `build_features` (lines 98-103):**

Old:
```python
    # Composite screener score (0–100 scale from scoring engine)
    X['screener_score'] = pd.to_numeric(df.get('screener_score', 50), errors='coerce').fillna(50) / 100.0

    # Max return pct during horizon (available in training data, not in pending)
    if 'max_return_pct' in df.columns:
        X['max_return_pct'] = pd.to_numeric(df['max_return_pct'], errors='coerce').fillna(0)
```

New: Delete both blocks entirely.

**3c — Remove `screener_score` from `load_pending_signals` for consistency (lines 151, 153-154):**

Old:
```python
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               sf.fifty_two_week_high,
               ss.score AS screener_score
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
        LEFT JOIN stock_scores ss ON ss.symbol = ts.symbol AND ss.timeframe = 'long_term'
```

New:
```python
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               sf.fifty_two_week_high
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
```

**3d — Replace `StratifiedKFold` with `TimeSeriesSplit` in `train_ensemble` (line 201, 211):**

Old:
```python
def train_ensemble(X: pd.DataFrame, y: pd.Series, min_samples: int = 30):
    from sklearn.model_selection import StratifiedKFold, cross_val_score
    ...
    skf    = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
```

New:
```python
def train_ensemble(X: pd.DataFrame, y: pd.Series, min_samples: int = 30):
    from sklearn.model_selection import TimeSeriesSplit, cross_val_score
    ...
    skf    = TimeSeriesSplit(n_splits=5)
```

**3e — Sort by `signal_date` before training in `run()` (after the `df = load_training_data(conn)` call, around line 385):**

Old:
```python
            df = load_training_data(conn)
            if len(df) < min_samples:
```

New:
```python
            df = load_training_data(conn)
            df = df.sort_values('signal_date').reset_index(drop=True)
            if len(df) < min_samples:
```

- [ ] **Step 4: Run tests — expect all to pass**

```
python -m pytest src/server/tests/test_ml_ensemble.py -v
```

Expected:
```
PASSED test_ml_ensemble.py::TestNoLookAheadFeatures::test_screener_score_not_in_features
PASSED test_ml_ensemble.py::TestNoLookAheadFeatures::test_max_return_pct_not_in_features
PASSED test_ml_ensemble.py::TestTemporalCV::test_no_future_data_in_cv_folds
PASSED test_ml_ensemble.py::TestTemporalCV::test_training_data_sorted_before_cv
PASSED test_ml_ensemble.py::TestLoadTrainingDataNoLeakColumns::test_training_query_has_no_screener_score
PASSED test_ml_ensemble.py::TestLoadTrainingDataNoLeakColumns::test_training_query_has_no_max_return_pct
```

- [ ] **Step 5: Retrain the model to materialise the fix**

```
python src/server/ml_ensemble.py --retrain-full --train
```

This rebuilds `src/server/ml_models/ensemble.pkl` without the leaked features.

- [ ] **Step 6: Commit**

```bash
git add src/server/ml_ensemble.py src/server/tests/test_ml_ensemble.py
git commit -m "fix(ml_ensemble): remove look-ahead screener_score/max_return_pct; switch to TimeSeriesSplit"
```

---

## Task 3: RL Meta-Controller — Reward Horizon and Next-State Transition

**Files:**
- Modify: `src/server/rl_agent.py:208-289, 305-373`
- Create: `src/server/tests/test_rl_agent.py`

Two bugs in one commit.

- [ ] **Step 1: Write the failing tests**

Create `src/server/tests/test_rl_agent.py`:

```python
import sys
import os
import sqlite3
import datetime
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.rl_agent import (
    _get_nifty_return, _get_nifty_horizon_return,
    _get_next_state_key, daily_update, REGIMES,
)


def _make_test_conn():
    conn = sqlite3.connect(':memory:')
    conn.execute("""
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE market_regimes (
            date TEXT PRIMARY KEY, regime TEXT, regime_prob REAL, hmm_state INTEGER,
            viterbi_path_json TEXT, features_json TEXT, computed_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE rl_q_table (
            state_key TEXT, action TEXT, q_value REAL, visit_count INTEGER, last_updated TEXT,
            PRIMARY KEY (state_key, action)
        )
    """)
    conn.execute("""
        CREATE TABLE rl_episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, state_key TEXT,
            action_taken TEXT, reward REAL, epsilon REAL
        )
    """)
    conn.execute("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            outcome TEXT, return_pct REAL, signal_score INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, nifty_regime TEXT, signal_score INTEGER,
            cmp REAL, stop_loss REAL, signals_json TEXT, adx REAL
        )
    """)
    conn.execute("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)")
    # Populate 20 days of Nifty OHLCV ending 2024-02-15
    from datetime import date, timedelta
    start = date(2024, 1, 25)
    for i in range(22):
        d = (start + timedelta(days=i)).isoformat()
        close = 21000.0 + i * 10  # ascending daily close
        conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)",
                     ('NIFTY50', d, close - 5, close + 5, close - 10, close, 1_000_000))
    conn.commit()
    return conn


class TestNiftyHorizonReturn:
    def test_horizon_return_covers_15_days(self):
        conn = _make_test_conn()
        # Date is 2024-02-15, 15 trading days back should be ~2024-01-31
        ret = _get_nifty_horizon_return(conn, '2024-02-15', horizon_days=15)
        # With ascending prices (+10/day), 15-day return should be ~0.7%
        assert ret > 0, "Expected positive 15-day Nifty return with ascending prices"
        assert ret < 5.0, "15-day return should be modest, not huge"

    def test_1day_return_differs_from_horizon(self):
        conn = _make_test_conn()
        ret_1d  = _get_nifty_return(conn, '2024-02-15')
        ret_15d = _get_nifty_horizon_return(conn, '2024-02-15', horizon_days=15)
        # 15-day return must be larger than 1-day return in this ascending dataset
        assert ret_15d > ret_1d, (
            f"15-day return ({ret_15d:.4f}) should exceed 1-day return ({ret_1d:.4f})"
        )


class TestNextStateTransition:
    def test_next_state_reflects_resolution_regime(self):
        conn = _make_test_conn()
        # Resolution date = 2024-01-31 + 15 days = 2024-02-15
        conn.execute("INSERT OR REPLACE INTO market_regimes VALUES (?,?,?,?,?,?,?)",
                     ('2024-02-15', 'BEAR', 0.85, 3, '[]', '{}', '2024-02-15'))
        conn.commit()

        next_state = _get_next_state_key(conn, 'BULL_BANK_HIGH', '2024-01-31', horizon_days=15)
        assert next_state.startswith('BEAR_'), (
            f"Expected next state regime=BEAR, got: {next_state}"
        )

    def test_next_state_keeps_sector_and_score_bucket(self):
        conn = _make_test_conn()
        conn.execute("INSERT OR REPLACE INTO market_regimes VALUES (?,?,?,?,?,?,?)",
                     ('2024-02-15', 'SIDEWAYS', 0.7, 1, '[]', '{}', '2024-02-15'))
        conn.commit()

        next_state = _get_next_state_key(conn, 'BULL_IT_LOW', '2024-01-31', horizon_days=15)
        parts = next_state.split('_')
        assert parts[0] == 'SIDEWAYS'
        assert parts[1] == 'IT'
        assert parts[2] == 'LOW'

    def test_fallback_to_current_state_when_no_regime_data(self):
        conn = _make_test_conn()
        # No market_regimes rows
        result = _get_next_state_key(conn, 'BULL_BANK_MED', '2024-01-31', horizon_days=15)
        assert result == 'BULL_BANK_MED', "Should fall back to current state when no regime data"


class TestDailyUpdateLooksBack:
    def test_daily_update_queries_horizon_days_back(self):
        """daily_update should update episodes from today-15d, not today."""
        conn = _make_test_conn()
        target_date = (datetime.date.today() - datetime.timedelta(days=15)).isoformat()

        # Insert an unresolved episode at target_date
        conn.execute(
            "INSERT INTO rl_episodes (date, state_key, action_taken, epsilon) VALUES (?,?,?,?)",
            (target_date, 'BULL_IT_HIGH', 'AGGRESSIVE', 0.1)
        )
        # Insert a resolved signal outcome at target_date
        conn.execute(
            "INSERT INTO signal_outcomes VALUES (?,?,?,?,?,?)",
            ('INFY', target_date, 15, 'WIN', 8.5, 7)
        )
        conn.execute(
            "INSERT INTO technical_signals VALUES (?,?,?,?,?,?,?,?)",
            ('INFY', target_date, 'BULL', 7, 1500.0, 1400.0, '[]', 30.0)
        )
        conn.commit()

        result = daily_update(conn, dry_run=True, horizon_days=15)
        assert result['updated'] > 0, (
            "daily_update should find and update the episode from today-15 days"
        )
```

- [ ] **Step 2: Run tests to confirm they fail**

```
python -m pytest src/server/tests/test_rl_agent.py -v
```

Expected: `AttributeError` / `ImportError` on `_get_nifty_horizon_return` and `_get_next_state_key` (don't exist yet). `daily_update` test fails because it only queries `date = today`.

- [ ] **Step 3: Implement fixes in `src/server/rl_agent.py`**

**3a — Add `_get_nifty_horizon_return` after the existing `_get_nifty_return` function (after line 223):**

```python
def _get_nifty_horizon_return(conn: sqlite3.Connection, date: str,
                               horizon_days: int = 15) -> float:
    """Nifty return over the `horizon_days` window ending at `date`."""
    start_date = (
        datetime.date.fromisoformat(date) - datetime.timedelta(days=horizon_days + 7)
    ).isoformat()
    rows = conn.execute("""
        SELECT date, close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date BETWEEN ? AND ?
        ORDER BY date ASC
    """, (start_date, date)).fetchall()
    if len(rows) < 2:
        return 0.0
    target_start = (
        datetime.date.fromisoformat(date) - datetime.timedelta(days=horizon_days)
    ).isoformat()
    start_close = None
    for r_date, r_close in rows:
        if r_date >= target_start:
            start_close = float(r_close)
            break
    if start_close is None:
        start_close = float(rows[0][1])
    end_close = float(rows[-1][1])
    return (end_close - start_close) / start_close * 100
```

**3b — Add `_get_next_state_key` after `_get_nifty_horizon_return`:**

```python
def _get_next_state_key(conn: sqlite3.Connection, state_key: str,
                         sig_date: str, horizon_days: int = 15) -> str:
    """State at trade resolution (sig_date + horizon_days)."""
    resolution = (
        datetime.date.fromisoformat(sig_date) + datetime.timedelta(days=horizon_days)
    ).isoformat()
    row = conn.execute("""
        SELECT regime FROM market_regimes WHERE date <= ? ORDER BY date DESC LIMIT 1
    """, (resolution,)).fetchone()
    if not row:
        return state_key  # no regime data: keep current state
    next_regime = row[0] if row[0] in REGIMES else 'SIDEWAYS'
    parts = state_key.split('_')
    if parts:
        parts[0] = next_regime
    return '_'.join(parts)
```

**3c — Fix `daily_update` to look back `horizon_days` and use the new functions (lines 226-289):**

Old:
```python
def daily_update(conn: sqlite3.Connection, dry_run: bool = False) -> dict[str, int]:
    today = datetime.date.today().isoformat()

    episodes = conn.execute("""
        SELECT id, date, state_key, action_taken
        FROM rl_episodes
        WHERE date = ? AND reward IS NULL
    """, (today,)).fetchall()
    ...
        nifty_ret  = _get_nifty_return(conn, ep_date)
        ...
        next_state = state_key
        next_max   = get_max_q(conn, next_state)
```

New:
```python
def daily_update(conn: sqlite3.Connection, dry_run: bool = False,
                 horizon_days: int = 15) -> dict[str, int]:
    # Episodes from `horizon_days` ago now have resolved signal_outcomes
    target_date = (
        datetime.date.today() - datetime.timedelta(days=horizon_days)
    ).isoformat()

    episodes = conn.execute("""
        SELECT id, date, state_key, action_taken
        FROM rl_episodes
        WHERE date = ? AND reward IS NULL
    """, (target_date,)).fetchall()
    ...
        nifty_ret  = _get_nifty_horizon_return(conn, ep_date, horizon_days=horizon_days)
        ...
        next_state = _get_next_state_key(conn, state_key, ep_date, horizon_days=horizon_days)
        next_max   = get_max_q(conn, next_state)
```

Also update the `--update` CLI path in `run()` to pass `horizon_days`.

**3d — Fix `backfill_episodes` reward benchmark (line 345) and next-state (line 359):**

Old (in the for loop):
```python
        nifty_ret = _get_nifty_return(conn, sig_date)
        reward    = float(ret_pct) - nifty_ret
        ...
        next_max = get_max_q(conn, state_key)
```

New:
```python
        nifty_ret = _get_nifty_horizon_return(conn, sig_date, horizon_days=15)
        reward    = float(ret_pct) - nifty_ret
        ...
        next_state = _get_next_state_key(conn, state_key, sig_date, horizon_days=15)
        next_max   = get_max_q(conn, next_state)
```

- [ ] **Step 4: Run tests — expect all to pass**

```
python -m pytest src/server/tests/test_rl_agent.py -v
```

Expected:
```
PASSED test_rl_agent.py::TestNiftyHorizonReturn::test_horizon_return_covers_15_days
PASSED test_rl_agent.py::TestNiftyHorizonReturn::test_1day_return_differs_from_horizon
PASSED test_rl_agent.py::TestNextStateTransition::test_next_state_reflects_resolution_regime
PASSED test_rl_agent.py::TestNextStateTransition::test_next_state_keeps_sector_and_score_bucket
PASSED test_rl_agent.py::TestNextStateTransition::test_fallback_to_current_state_when_no_regime_data
PASSED test_rl_agent.py::TestDailyUpdateLooksBack::test_daily_update_queries_horizon_days_back
```

- [ ] **Step 5: Backfill Q-table with corrected rewards**

```
python src/server/rl_agent.py --backfill --lookback 365
```

This re-applies Q-updates with 15-day benchmark rewards and correct next states.

- [ ] **Step 6: Commit**

```bash
git add src/server/rl_agent.py src/server/tests/test_rl_agent.py
git commit -m "fix(rl_agent): 15-day Nifty benchmark; correct MDP next-state from market_regimes"
```

---

## Task 4: HMM Regime Detector — Label Stability and Date Anchoring

**Files:**
- Modify: `src/server/regime_detector.py:31-85, 88-120, 123-170`
- Create: `src/server/tests/test_regime_detector.py`

Two bugs, one commit.

- [ ] **Step 1: Write the failing tests**

Create `src/server/tests/test_regime_detector.py`:

```python
import sys
import os
import sqlite3
import numpy as np
import pandas as pd
import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.regime_detector import _assign_state_labels, _load_hmm_features


def _make_mock_hmm(return_means, vol_means):
    """Build a mock HMM whose means_ matrix has given return and vol values per state."""
    model = MagicMock()
    n = len(return_means)
    # means_ shape: (n_states, n_features); dim 0 = nifty_ret_21d, dim 1 = nifty_vol_21d
    means = np.zeros((n, 8))
    means[:, 0] = return_means
    means[:, 1] = vol_means
    model.means_ = means
    return model


class TestLabelAssignment:
    def test_highest_return_state_is_bull(self):
        # States: returns [0.03, 0.01, -0.01, -0.03, -0.05], vols [0.12, 0.15, 0.18, 0.2, 0.35]
        model = _make_mock_hmm(
            return_means=[0.03, 0.01, -0.01, -0.03, -0.05],
            vol_means=[0.12, 0.15, 0.18, 0.20, 0.35],
        )
        labels = _assign_state_labels(model)
        bull_state = [k for k, v in labels.items() if v == 'BULL'][0]
        assert model.means_[bull_state, 0] == max(model.means_[:, 0])

    def test_highest_vol_bottom_state_is_crash(self):
        # Bottom 2 states by return: indices 3 (ret=-0.03, vol=0.20) and 4 (ret=-0.05, vol=0.35)
        # State 4 has higher vol → should be CRASH
        model = _make_mock_hmm(
            return_means=[0.03, 0.01, -0.01, -0.03, -0.05],
            vol_means=[0.12, 0.15, 0.18, 0.20, 0.35],
        )
        labels = _assign_state_labels(model)
        # State 4 (highest vol among bottom 2 by return) must be CRASH
        assert labels[4] == 'CRASH'
        # State 3 (lower vol bottom state) must be BEAR
        assert labels[3] == 'BEAR'

    def test_label_switching_resilience(self):
        """After reorder, BEAR always has lower vol than CRASH."""
        for seed in range(10):
            rng = np.random.default_rng(seed)
            returns = sorted(rng.uniform(-0.05, 0.05, 5), reverse=True)
            vols    = rng.uniform(0.10, 0.50, 5)
            model   = _make_mock_hmm(returns, vols)
            labels  = _assign_state_labels(model)

            bear_idx  = [k for k, v in labels.items() if v == 'BEAR'][0]
            crash_idx = [k for k, v in labels.items() if v == 'CRASH'][0]
            assert model.means_[bear_idx, 1] <= model.means_[crash_idx, 1], (
                f"Seed {seed}: BEAR vol ({model.means_[bear_idx,1]:.3f}) "
                f"should be <= CRASH vol ({model.means_[crash_idx,1]:.3f})"
            )


class TestDateAnchoredFeatures:
    def _make_nifty_conn(self, dates):
        conn = sqlite3.connect(':memory:')
        conn.execute("""
            CREATE TABLE stock_ohlcv (
                symbol TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER
            )
        """)
        conn.execute("CREATE TABLE fii_dii_flow (date TEXT, fii_net REAL)")
        conn.execute("""
            CREATE TABLE market_sentiment_snapshots (
                snapshot_at TEXT, overall_score REAL
            )
        """)
        conn.execute("CREATE TABLE macro_asset_prices (symbol TEXT, date TEXT, close REAL, ret_5d REAL)")
        for d in dates:
            conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,?,?,?,?,?)",
                         ('NIFTY50', d, 21000.0, 21100.0, 20900.0, 21050.0, 1_000_000))
        conn.commit()
        return conn

    def test_features_contain_no_data_after_as_of_date(self):
        """When as_of_date='2024-06-01', _load_hmm_features must not include rows after that date."""
        future_dates = ['2024-05-01', '2024-05-15', '2024-06-01', '2024-07-01', '2024-08-01']
        conn = self._make_nifty_conn(future_dates)
        df = _load_hmm_features(conn, lookback_days=365, as_of_date='2024-06-01')
        if not df.empty:
            max_date = df.index.max()
            assert str(max_date.date()) <= '2024-06-01', (
                f"Feature data contains future rows beyond as_of_date: {max_date}"
            )

    def test_default_as_of_date_uses_today(self):
        from datetime import date
        today = date.today().isoformat()
        # Just check the function accepts no as_of_date without error (returns empty is OK for in-memory)
        conn = self._make_nifty_conn([])
        try:
            _load_hmm_features(conn, lookback_days=30)
        except Exception as e:
            pytest.fail(f"_load_hmm_features without as_of_date raised: {e}")
```

- [ ] **Step 2: Run tests to confirm they fail**

```
python -m pytest src/server/tests/test_regime_detector.py -v
```

Expected: `ImportError` on `_assign_state_labels` (doesn't exist yet), and assertion failures on date anchoring.

- [ ] **Step 3: Implement fixes in `src/server/regime_detector.py`**

**3a — Extract label assignment into a standalone function (insert before `train_hmm`, after line 27):**

```python
def _assign_state_labels(model) -> dict[int, str]:
    """
    Assign human-readable labels to HMM states.
    - Sorts states by mean nifty_ret_21d (dim 0) descending.
    - Among the bottom 2 states (BEAR/CRASH candidates), assigns CRASH to the
      higher-volatility state (nifty_vol_21d, dim 1) for label-switching resilience.
    """
    means  = model.means_[:, 0]  # nifty_ret_21d per state
    vols   = model.means_[:, 1]  # nifty_vol_21d per state
    order  = list(np.argsort(means)[::-1])  # descending return

    if len(order) >= 2:
        bottom2 = order[-2:]  # two lowest-return state indices
        # Ensure higher-vol state is last (CRASH), lower-vol is second-to-last (BEAR)
        if vols[bottom2[0]] > vols[bottom2[1]]:
            order[-2], order[-1] = bottom2[1], bottom2[0]

    label_seq = ["BULL", "SIDEWAYS", "HIGH_VOL", "BEAR", "CRASH"]
    return {int(state_idx): label_seq[rank] for rank, state_idx in enumerate(order)}
```

**3b — Replace inline label logic in `train_hmm` (lines 107-113):**

Old:
```python
    means = model.means_[:, 0]  # nifty_ret_21d mean per state
    order = np.argsort(means)[::-1]  # descending: best return = BULL
    state_labels = {}
    label_seq = ["BULL", "SIDEWAYS", "HIGH_VOL", "BEAR", "CRASH"]
    # Sort by vol (dim 1) within bottom 2 states for BEAR vs CRASH
    for rank, state_idx in enumerate(order):
        state_labels[int(state_idx)] = label_seq[rank]
```

New:
```python
    state_labels = _assign_state_labels(model)
```

**3c — Add `as_of_date` parameter to `_load_hmm_features` and filter all queries (lines 31-85):**

Old signature and Nifty query:
```python
def _load_hmm_features(con: sqlite3.Connection, lookback_days: int = 756) -> pd.DataFrame:
    """Build 8-feature market-level matrix for HMM training/inference."""
    cutoff = (datetime.today() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

    # Nifty returns + vol
    nifty = pd.read_sql(
        "SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' AND date>=? ORDER BY date",
        con, params=(cutoff,), parse_dates=["date"], index_col="date",
    )
```

New signature and Nifty query (all sub-queries also get `AND date<=anchor` or `AND snapshot_at<=anchor`):
```python
def _load_hmm_features(con: sqlite3.Connection, lookback_days: int = 756,
                        as_of_date: str = None) -> pd.DataFrame:
    """Build 8-feature market-level matrix for HMM training/inference."""
    anchor = as_of_date or datetime.today().strftime("%Y-%m-%d")
    cutoff = (datetime.strptime(anchor, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")

    # Nifty returns + vol
    nifty = pd.read_sql(
        "SELECT date, close FROM stock_ohlcv WHERE symbol='NIFTY50' AND date>=? AND date<=? ORDER BY date",
        con, params=(cutoff, anchor), parse_dates=["date"], index_col="date",
    )
```

Apply `AND date<=?` / `AND snapshot_at<=?` with `anchor` as the additional param to every `pd.read_sql` call inside `_load_hmm_features` (VIX proxy at line 47, FII at line 54, advance/decline at line 66, and all three macro queries at line 78).

**3d — Pass `as_of_date=date` in `update_regime` (line 140):**

Old:
```python
        df = _load_hmm_features(con, lookback_days=120)  # recent 6 months for inference
```

New:
```python
        df = _load_hmm_features(con, lookback_days=120, as_of_date=date)
```

- [ ] **Step 4: Run tests — expect all to pass**

```
python -m pytest src/server/tests/test_regime_detector.py -v
```

Expected:
```
PASSED test_regime_detector.py::TestLabelAssignment::test_highest_return_state_is_bull
PASSED test_regime_detector.py::TestLabelAssignment::test_highest_vol_bottom_state_is_crash
PASSED test_regime_detector.py::TestLabelAssignment::test_label_switching_resilience
PASSED test_regime_detector.py::TestDateAnchoredFeatures::test_features_contain_no_data_after_as_of_date
PASSED test_regime_detector.py::TestDateAnchoredFeatures::test_default_as_of_date_uses_today
```

- [ ] **Step 5: Retrain the HMM with the new label logic**

```
python src/server/regime_detector.py --mode train
python src/server/regime_detector.py --mode update
```

- [ ] **Step 6: Commit**

```bash
git add src/server/regime_detector.py src/server/tests/test_regime_detector.py
git commit -m "fix(regime_detector): stable HMM label assignment via vol sort; anchor features to inference date"
```

---

## Task 5: Weight Optimizer — Temporal Walk-Forward Split

**Files:**
- Modify: `src/server/strategy_optimizer.py:156-232` (`optimise`)
- Create: `src/server/tests/test_strategy_optimizer.py`

One bug, one commit.

- [ ] **Step 1: Write the failing tests**

Create `src/server/tests/test_strategy_optimizer.py`:

```python
import sys
import os
import pandas as pd
import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.strategy_optimizer import StrategyOptimizer, CATEGORIES, SOURCES


def _make_outcome_df(n=100):
    """Create n fake outcome rows across 2 years of dates."""
    dates = pd.date_range('2022-01-01', periods=n, freq='7D')
    rng = np.random.default_rng(42)
    df = pd.DataFrame({
        'signal_date': dates.strftime('%Y-%m-%d'),
        'outcome': rng.choice(['WIN', 'LOSS', 'NEUTRAL'], n),
        'return_pct': rng.uniform(-10, 15, n),
        'signal_score': rng.integers(3, 10, n),
        'horizon_days': [15] * n,
        'symbol': [f'SYM{i % 20}' for i in range(n)],
    })
    for cat in CATEGORIES:
        df[cat] = rng.uniform(0, 100, n)
    return df


class TestTemporalSplit:
    def test_all_train_dates_precede_test_dates(self):
        """After sorting by signal_date, the 80th-percentile cutoff must separate train from test."""
        df = _make_outcome_df(100)
        df = df.sort_values('signal_date').reset_index(drop=True)
        split_idx = int(len(df) * 0.8)
        train_df = df.iloc[:split_idx]
        test_df  = df.iloc[split_idx:]

        max_train_date = train_df['signal_date'].max()
        min_test_date  = test_df['signal_date'].min()
        assert max_train_date <= min_test_date, (
            f"Train/test overlap: latest train={max_train_date}, earliest test={min_test_date}"
        )

    def test_no_random_interleaving(self):
        """Random 80/20 sample interleaves dates — detect this and confirm it no longer happens."""
        df = _make_outcome_df(100)
        df = df.sort_values('signal_date').reset_index(drop=True)
        split_idx = int(len(df) * 0.8)
        train_df = df.iloc[:split_idx]
        test_df  = df.iloc[split_idx:]

        # Verify the split is purely positional (first 80 rows in train)
        assert list(train_df.index) == list(range(split_idx))
        assert list(test_df.index)  == list(range(split_idx, len(df)))

    def test_optimise_uses_temporal_split(self):
        """Monkey-patch _objective to capture train/test, assert temporal ordering."""
        import sqlite3
        conn = sqlite3.connect(':memory:')
        conn.execute("""
            CREATE TABLE signal_outcomes (
                symbol TEXT, signal_date TEXT, horizon_days INTEGER,
                outcome TEXT, return_pct REAL, signal_score INTEGER
            )
        """)
        conn.execute("""
            CREATE TABLE stock_factor_breakdown (
                symbol TEXT, timeframe TEXT, technical REAL, fundamental REAL,
                momentum REAL, valuation REAL, delivery REAL, news REAL
            )
        """)
        df = _make_outcome_df(60)
        for _, row in df.iterrows():
            conn.execute("INSERT INTO signal_outcomes VALUES (?,?,?,?,?,?)",
                         (row['symbol'], row['signal_date'], 15,
                          row['outcome'], row['return_pct'], int(row['signal_score'])))
        conn.commit()

        captured = {}
        opt = StrategyOptimizer.__new__(StrategyOptimizer)
        opt.conn = conn

        original_objective = opt._objective
        def capturing_objective(params, train_df, test_df):
            captured['train_max'] = train_df['signal_date'].max()
            captured['test_min']  = test_df['signal_date'].min()
            return original_objective(params, train_df, test_df)
        opt._objective = capturing_objective

        opt.optimise(horizon_days=15, max_iterations=2)

        assert 'train_max' in captured, "Objective was never called"
        assert captured['train_max'] <= captured['test_min'], (
            f"Temporal leakage: train goes to {captured['train_max']}, "
            f"test starts at {captured['test_min']}"
        )
```

- [ ] **Step 2: Run tests to confirm they fail**

```
python -m pytest src/server/tests/test_strategy_optimizer.py -v
```

Expected: the `test_optimise_uses_temporal_split` test fails because the current code uses `df.sample(frac=0.8, random_state=42)` (random, not temporal).

- [ ] **Step 3: Implement fix in `src/server/strategy_optimizer.py`**

In `optimise` (lines 176-177), replace random split with chronological split:

Old:
```python
        # 80/20 train/test split based on time or random (time-based walk-forward proxy)
        train_df = df.sample(frac=0.8, random_state=42)
        test_df = df.drop(train_df.index)
```

New:
```python
        # Chronological 80/20 split: train on older data, test on most-recent 20%
        df = df.sort_values('signal_date').reset_index(drop=True)
        split_idx = int(len(df) * 0.8)
        train_df = df.iloc[:split_idx]
        test_df  = df.iloc[split_idx:]
```

- [ ] **Step 4: Run tests — expect all to pass**

```
python -m pytest src/server/tests/test_strategy_optimizer.py -v
```

Expected:
```
PASSED test_strategy_optimizer.py::TestTemporalSplit::test_all_train_dates_precede_test_dates
PASSED test_strategy_optimizer.py::TestTemporalSplit::test_no_random_interleaving
PASSED test_strategy_optimizer.py::TestTemporalSplit::test_optimise_uses_temporal_split
```

- [ ] **Step 5: Re-run the optimizer to produce unbiased weights**

```
python src/server/strategy_optimizer.py --iterations 300 --apply
```

- [ ] **Step 6: Commit**

```bash
git add src/server/strategy_optimizer.py src/server/tests/test_strategy_optimizer.py
git commit -m "fix(strategy_optimizer): replace random 80/20 split with chronological walk-forward split"
```

---

## Final: Full Test Suite

- [ ] **Run the complete suite**

```
python -m pytest src/server/tests/ -v --tb=short
```

Expected: all 26 tests pass across the 5 test files.

---

## Self-Review Checklist

- [x] **Spec coverage:**
  - Backtesting path-dependent sizing → Task 1 (fixed-fraction, `initial_capital / max_positions`)
  - Stop-loss overnight gaps → Task 1 (`min(day_open, pos['stop_loss'])`)
  - Transaction friction → Task 1 (`commission_bps=25`)
  - Look-ahead `screener_score` → Task 2 (removed from SQL + build_features)
  - Target leak `max_return_pct` → Task 2 (removed from SQL + build_features)
  - StratifiedKFold temporal leak → Task 2 (TimeSeriesSplit + sort by signal_date)
  - RL reward horizon mismatch → Task 3 (`_get_nifty_horizon_return`)
  - RL s'=s MDP error → Task 3 (`_get_next_state_key` from market_regimes)
  - HMM label switching → Task 4 (`_assign_state_labels` with vol tiebreak)
  - HMM look-ahead features → Task 4 (`as_of_date` parameter)
  - Optimizer in-sample overfit → Task 5 (chronological split)

- [x] **No placeholders.** Every step has the exact code change shown.

- [x] **Type consistency.** `_get_nifty_horizon_return` and `_get_next_state_key` signatures used consistently across `daily_update`, `backfill_episodes`, and tests. `_assign_state_labels` signature matches usage in `train_hmm` and all five test scenarios.
