"""AF-20261001-44: update_source_weights learned from labels the platform has since disowned.

* outcomes of INVALIDATED_CONFLICT signals (withdrawn; 31k screener rows at 3.3% win) and
* NEUTRAL rows the expiry path fabricated with exit_price NULL / 0.0% (42,808 h1 rows on
  gradeable trades -- another fix stops new ones, these still sit in the table).
Both went straight into signal_source_weights' win_rate / reward EMA.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from pg_test_support import pg_memory_conn  # noqa: E402
from reward_engine import update_source_weights  # noqa: E402


def _d(n):
    return (datetime.date.today() - datetime.timedelta(days=n)).isoformat()


def test_disowned_labels_are_not_learned_from():
    c = pg_memory_conn()
    c.executescript("""
        CREATE TABLE technical_signals (symbol TEXT, date TEXT, nifty_regime TEXT);
        CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, sector TEXT);
        CREATE TABLE unified_signals (id INTEGER PRIMARY KEY, symbol TEXT, signal_date TEXT,
            signal_source TEXT, status TEXT);
        CREATE TABLE unified_signal_outcomes (id INTEGER PRIMARY KEY, unified_signal_id INTEGER,
            symbol TEXT, signal_source TEXT, horizon_days INTEGER, return_pct REAL, outcome TEXT,
            exit_price REAL);
        CREATE TABLE signal_source_weights (signal_source TEXT, regime TEXT, sector TEXT,
            win_rate REAL, avg_return_pct REAL, total_signals INTEGER, total_wins INTEGER,
            total_losses INTEGER, avg_sharpe_ratio REAL, weight_multiplier REAL DEFAULT 1.0,
            last_updated TEXT, PRIMARY KEY (signal_source, regime, sector));
    """)
    c.execute("INSERT INTO nse_stocks VALUES ('INFY','IT')")
    rows = [  # (status, outcome, return_pct, exit_price)
        ('ACTIVE', 'WIN', 4.0, 104.0), ('ACTIVE', 'WIN', 4.0, 104.0), ('ACTIVE', 'WIN', 4.0, 104.0),
        ('INVALIDATED_CONFLICT', 'STOP_LOSS', -5.0, 95.0),
        ('INVALIDATED_CONFLICT', 'STOP_LOSS', -5.0, 95.0),
        ('ACTIVE', 'NEUTRAL', 0.0, None),   # fabricated by expiry
    ]
    for i, (status, outcome, ret, px) in enumerate(rows, start=1):
        c.execute("INSERT INTO unified_signals VALUES (?, 'INFY', ?, 'screener', ?)", (i, _d(2), status))
        c.execute("INSERT INTO unified_signal_outcomes (unified_signal_id, symbol, signal_source, "
                  "horizon_days, return_pct, outcome, exit_price) VALUES (?, 'INFY', 'screener', 1, ?, ?, ?)",
                  (i, ret, outcome, px))
    c.commit()
    res = update_source_weights(c, dry_run=False)
    assert res['processed'] == 3
    wr, n = c.execute("SELECT win_rate, total_signals FROM signal_source_weights").fetchone()
    assert (wr, n) == (1.0, 3)
