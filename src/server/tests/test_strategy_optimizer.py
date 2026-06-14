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
        """Verify that optimise() internally uses chronological split, not random."""
        # This test directly verifies the split logic by patching the _objective
        # method to capture what train/test dataframes are passed to it.
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
                momentum REAL, valuation REAL, delivery REAL, news REAL, other REAL
            )
        """)

        df = _make_outcome_df(60)
        rng = np.random.default_rng(42)

        # Insert signal outcomes
        for _, row in df.iterrows():
            conn.execute("INSERT INTO signal_outcomes VALUES (?,?,?,?,?,?)",
                         (row['symbol'], row['signal_date'], 15,
                          row['outcome'], row['return_pct'], int(row['signal_score'])))
            # Insert factor breakdown with all required columns
            conn.execute("""
                INSERT INTO stock_factor_breakdown
                (symbol, timeframe, technical, fundamental, momentum, valuation, delivery, news, other)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (row['symbol'], 'medium', rng.uniform(0, 100), rng.uniform(0, 100),
                  rng.uniform(0, 100), rng.uniform(0, 100), rng.uniform(0, 100),
                  rng.uniform(0, 100), rng.uniform(0, 100)))
        conn.commit()

        captured = {'objective_calls': []}
        opt = StrategyOptimizer.__new__(StrategyOptimizer)
        opt.conn = conn

        # Patch _objective to capture train/test splits
        original_objective = opt._objective.__func__  # Get unbound method

        def patched_objective(self, params, train_df, test_df):
            train_max = train_df['signal_date'].max()
            test_min = test_df['signal_date'].min()
            captured['objective_calls'].append({
                'train_max': train_max,
                'test_min': test_min,
                'train_size': len(train_df),
                'test_size': len(test_df),
            })
            return original_objective(self, params, train_df, test_df)

        opt._objective = patched_objective.__get__(opt, StrategyOptimizer)

        # Call optimise
        result = opt.optimise(horizon_days=15, max_iterations=2)

        # Verify at least one call captured the split
        assert len(captured['objective_calls']) > 0, "Objective was never called (empty data?)"

        # Check first call's temporal property
        first_call = captured['objective_calls'][0]
        assert first_call['train_max'] <= first_call['test_min'], (
            f"Temporal leakage detected in first objective call: "
            f"train_max={first_call['train_max']}, test_min={first_call['test_min']}"
        )
