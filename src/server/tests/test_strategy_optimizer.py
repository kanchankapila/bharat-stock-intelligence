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
        # StrategyOptimizer._read_df() builds DataFrames via dict(row), which needs a mapping
        # row type (matches the row_factory convention every other test file in this suite
        # already uses for connections passed into production code) -- a plain tuple isn't one.
        conn.row_factory = sqlite3.Row
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

        # Patch _compute_score, not _objective: _objective only ever evaluates train_df (its
        # own docstring: "test_df is scored separately in optimise() for reporting") -- the
        # held-out baseline/optimised scores are computed via direct self._compute_score(...,
        # test_df) calls in optimise(), never through self._objective. Patching _objective
        # (as this test previously did, with a (train_df, test_df) 2-arg signature that also
        # didn't match _objective's real 1-df signature) never sees test_df at all.
        # _compute_score is the common method both the train (via _objective) and test
        # (direct) paths funnel through, so patching it here captures both.
        original_compute_score = opt._compute_score.__func__  # Get unbound method

        def patched_compute_score(self, params, df):
            captured['objective_calls'].append({
                'min_date': df['signal_date'].min(),
                'max_date': df['signal_date'].max(),
                'size': len(df),
            })
            return original_compute_score(self, params, df)

        opt._compute_score = patched_compute_score.__get__(opt, StrategyOptimizer)

        # Call optimise
        result = opt.optimise(horizon_days=15, max_iterations=2)

        # Verify at least one call captured the split
        assert len(captured['objective_calls']) > 0, "Objective was never called (empty data?)"

        # _objective is called with either train_df (many times, larger, fixed size) or
        # test_df (fewer times, smaller, fixed size) -- distinguish by size and check no
        # temporal leakage between the two groups.
        by_size = {}
        for c in captured['objective_calls']:
            by_size.setdefault(c['size'], c)
        assert len(by_size) == 2, f"expected exactly 2 distinct df sizes (train, test), got sizes={sorted(by_size)}"
        smaller_size, larger_size = sorted(by_size)
        test_call, train_call = by_size[smaller_size], by_size[larger_size]
        assert train_call['max_date'] <= test_call['min_date'], (
            f"Temporal leakage detected: train_max={train_call['max_date']}, "
            f"test_min={test_call['min_date']}"
        )
