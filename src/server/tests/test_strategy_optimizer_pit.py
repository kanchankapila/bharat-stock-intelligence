"""AF-20261001-42/43: strategy_optimizer correctness.

-42 look-ahead: outcomes were joined to the CURRENT stock_factor_breakdown (by symbol only), so a
    2026-05 outcome was "explained" by factor scores computed months later.
    stock_factor_breakdown_history (58 snapshot dates since 2026-07-17) is the point-in-time copy.
    STOP_LOSS outcomes (a loss) were also filtered out of the objective.
-43 noise written as weights: `sector`, `other` and all three SOURCE weights have no data column
    in the objective, so differential_evolution returned arbitrary values for them and run() wrote
    them to app_settings (live 2026-09-27: other 1.8244, sector 1.2249, ETnow 1.0737), which
    scoring_engine.py loads at startup.
"""
import os
import sys
import sqlite3

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
from strategy_optimizer import (StrategyOptimizer, DEFAULT_CATEGORY_WEIGHTS,  # noqa: E402
                                DEFAULT_SOURCE_WEIGHTS)


def _db():
    conn = pg_memory_conn()
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE signal_outcomes (symbol TEXT, signal_date DATE, horizon_days INTEGER,
        outcome TEXT, return_pct REAL, signal_score INTEGER, signal_source TEXT DEFAULT 'technical')""")
    conn.execute("""CREATE TABLE stock_factor_breakdown_history (symbol TEXT, timeframe TEXT,
        snapshot_date DATE, technical REAL, fundamental REAL, momentum REAL, valuation REAL,
        delivery REAL, news REAL)""")
    conn.execute("""CREATE TABLE stock_factor_breakdown (symbol TEXT, timeframe TEXT, technical REAL,
        fundamental REAL, momentum REAL, valuation REAL, delivery REAL, news REAL)""")
    return conn


def _opt(conn):
    o = StrategyOptimizer.__new__(StrategyOptimizer)
    o.conn = conn
    return o


def test_factors_are_point_in_time_and_stop_loss_counts():
    c = _db()
    c.execute("INSERT INTO signal_outcomes VALUES ('A','2026-08-05',15,'WIN',3.0,5,'technical')")
    c.execute("INSERT INTO signal_outcomes VALUES ('A','2026-08-12',15,'STOP_LOSS',-6.0,5,'technical')")
    c.execute("INSERT INTO stock_factor_breakdown_history VALUES ('A','long_term','2026-08-04',10,10,10,10,10,10)")
    c.execute("INSERT INTO stock_factor_breakdown_history VALUES ('A','long_term','2026-08-11',20,20,20,20,20,20)")
    c.execute("INSERT INTO stock_factor_breakdown VALUES ('A','long_term',99,99,99,99,99,99)")
    df = _opt(c).load_signal_outcomes_with_factors(15).sort_values('signal_date')
    assert list(df['outcome']) == ['WIN', 'STOP_LOSS']
    assert list(df['technical']) == [10, 20]   # as-of each signal date, never today's 99


def test_unfitted_weights_stay_at_defaults():
    c = _db()
    rng = np.random.default_rng(0)
    for i in range(80):
        d = f"2026-08-{(i % 28) + 1:02d}"
        sym = f"S{i}"
        c.execute("INSERT INTO signal_outcomes VALUES (?,?,15,?,?,5,'technical')",
                  (sym, d, 'WIN' if i % 3 else 'LOSS', float(rng.uniform(-5, 5))))
        c.execute("INSERT INTO stock_factor_breakdown_history VALUES (?, 'long_term', '2026-08-01',?,?,?,?,?,?)",
                  (sym, *[float(v) for v in rng.uniform(0, 100, 6)]))
    res = _opt(c).optimise(horizon_days=15, max_iterations=2, popsize=4)
    assert res['source_weights'] == DEFAULT_SOURCE_WEIGHTS
    assert res['category_weights']['sector'] == DEFAULT_CATEGORY_WEIGHTS['sector']
    assert res['category_weights']['other'] == DEFAULT_CATEGORY_WEIGHTS['other']
