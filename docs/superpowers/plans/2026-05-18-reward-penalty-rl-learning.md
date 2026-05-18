# Reward/Penalty Loop + RL Meta-Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all open ML feedback loops and add a tabular Q-learning regime-aware meta-controller that improves signal accuracy by learning which signal types to amplify or suppress per market regime/sector context.

**Architecture:** Four new Python scripts (outcome_resolver, reward_engine, rl_agent, backtest_optimizer) feed a closed daily loop orchestrated by two new BullMQ jobs. scoring_engine.py reads signal_type_weights and rl_policy at startup; technicalSignalsService.ts gates low-probability signals from the frontend. Three new SQLite tables persist the RL and reward state.

**Tech Stack:** Python 3.11+, SQLite (better-sqlite3 on Node side, sqlite3 on Python side), BullMQ, tRPC/Zod, existing Backtester class from backtester.py, existing SGD ensemble from online_learner.py.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/server/db.ts` | Add 3 new tables: signal_type_weights, rl_q_table, rl_episodes |
| Create | `src/server/outcome_resolver.py` | Auto-label signal_outcomes from OHLCV with STOP_LOSS detection |
| Create | `src/server/reward_engine.py` | EMA reward/penalty → signal_type_weights table |
| Create | `src/server/rl_agent.py` | Q-learning meta-controller: state, policy, episode logging, daily update |
| Create | `src/server/backtest_optimizer.py` | Grid search over (min_score, horizon, SL%) → optimal params in app_settings |
| Modify | `src/server/scoring_engine.py` | Load signal_type_weights + RL policy at startup; apply multipliers |
| Modify | `src/server/technicalSignalsService.ts:1025-1032` | Add win_probability gate to getTechnicalSignalsForDate |
| Modify | `src/server/queues.ts` | Add daily-learning-loop + weekly-backtest-optimizer BullMQ jobs |
| Modify | `src/server/router.ts` | Add 4 new tRPC endpoints for dashboard visibility |
| Create | `src/server/tests/test_outcome_resolver.py` | pytest tests for outcome resolver |
| Create | `src/server/tests/test_reward_engine.py` | pytest tests for reward engine |
| Create | `src/server/tests/test_rl_agent.py` | pytest tests for Q-learning math |
| Create | `src/server/tests/test_backtest_optimizer.py` | pytest tests for grid search logic |

---

## Task 1: DB Schema — 3 New Tables

**Files:**
- Modify: `src/server/db.ts` (after the last `db.exec` block, before `migrateColumn` section at line 668)

- [ ] **Step 1: Add the new tables block**

Insert the following immediately after the closing `\`);` of the ML Feedback Framework block (after line 666) and before the `// --- Migrations & Upgrades ---` comment (line 668):

```typescript
// --- RL & Reward Loop Tables ---
db.exec(`
  -- Per-(signal_type, regime, sector) EMA-smoothed reward weights
  CREATE TABLE IF NOT EXISTS signal_type_weights (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_type  TEXT NOT NULL,
    regime       TEXT NOT NULL,
    sector       TEXT NOT NULL DEFAULT 'ALL',
    weight       REAL NOT NULL DEFAULT 1.0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL,
    UNIQUE(signal_type, regime, sector)
  );
  CREATE INDEX IF NOT EXISTS idx_stw_key ON signal_type_weights(signal_type, regime, sector);

  -- Q-learning table: Q(state, action) values
  CREATE TABLE IF NOT EXISTS rl_q_table (
    state_key    TEXT NOT NULL,
    action       TEXT NOT NULL,
    q_value      REAL NOT NULL DEFAULT 0.0,
    visit_count  INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL,
    PRIMARY KEY (state_key, action)
  );

  -- Audit trail of every RL episode (state chosen, action taken, reward assigned later)
  CREATE TABLE IF NOT EXISTS rl_episodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    state_key    TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    reward       REAL,
    epsilon      REAL,
    notes        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rlepi_date ON rl_episodes(date DESC);
`);
```

- [ ] **Step 2: Verify the server starts without errors**

```bash
npm run dev
```
Expected: server starts, no SQLite errors about missing tables.

- [ ] **Step 3: Confirm tables exist**

```bash
cd c:/Github/bharat-stock-intelligence
python -c "import sqlite3; c=sqlite3.connect('database.sqlite'); print([r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('signal_type_weights','rl_q_table','rl_episodes')\").fetchall()])"
```
Expected: `['signal_type_weights', 'rl_q_table', 'rl_episodes']`

- [ ] **Step 4: Commit**

```bash
git add src/server/db.ts
git commit -m "feat(db): add signal_type_weights, rl_q_table, rl_episodes tables"
```

---

## Task 2: `outcome_resolver.py` — Auto-label Signal Outcomes

**Files:**
- Create: `src/server/outcome_resolver.py`
- Create: `src/server/tests/test_outcome_resolver.py`

Note: A TypeScript equivalent (`signalOutcomesService.ts`) already exists but does not detect STOP_LOSS from intraday lows. This Python version adds that and runs as part of the daily BullMQ job.

- [ ] **Step 1: Create the test file first**

Create `src/server/tests/__init__.py` (empty file to make it a package).

Create `src/server/tests/test_outcome_resolver.py`:

```python
import sqlite3, sys, os, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def make_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, cmp REAL, signal_score INTEGER,
            signals_json TEXT, stop_loss TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE stock_ohlcv (
            symbol TEXT, date TEXT, open REAL, high REAL,
            low REAL, close REAL, volume INTEGER,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
    """)
    return conn

def test_win_outcome():
    conn = make_db()
    # Signal 20 days ago, entry 100
    signal_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    exit_date   = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
    conn.execute("INSERT INTO technical_signals VALUES (?,?,100.0,7,'[]','90.0')",
                 ('RELIANCE', signal_date))
    conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,102,105,99,103,1000000)",
                 ('RELIANCE', exit_date))
    conn.commit()

    from outcome_resolver import resolve_outcomes
    result = resolve_outcomes(conn, horizon_days=15, dry_run=False)
    assert result['resolved'] >= 1

    row = conn.execute(
        "SELECT outcome, return_pct FROM signal_outcomes WHERE symbol='RELIANCE'"
    ).fetchone()
    assert row is not None
    assert row[0] == 'WIN'
    assert row[1] > 1.0

def test_stop_loss_outcome():
    conn = make_db()
    signal_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    # Day 3 after signal: intraday low hits stop-loss (90)
    sl_hit_date = (datetime.date.today() - datetime.timedelta(days=17)).isoformat()
    conn.execute("INSERT INTO technical_signals VALUES (?,?,100.0,6,'[]','90.0')",
                 ('TCS', signal_date))
    conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,98,99,89,97,500000)",
                 ('TCS', sl_hit_date))
    conn.commit()

    from outcome_resolver import resolve_outcomes
    result = resolve_outcomes(conn, horizon_days=15, dry_run=False)
    assert result['resolved'] >= 1

    row = conn.execute(
        "SELECT outcome FROM signal_outcomes WHERE symbol='TCS'"
    ).fetchone()
    assert row is not None
    assert row[0] == 'STOP_LOSS'

def test_dry_run_writes_nothing():
    conn = make_db()
    signal_date = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    exit_date   = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
    conn.execute("INSERT INTO technical_signals VALUES (?,?,100.0,5,'[]',None)",
                 ('INFY', signal_date))
    conn.execute("INSERT INTO stock_ohlcv VALUES (?,?,110,112,108,111,200000)",
                 ('INFY', exit_date))
    conn.commit()

    from outcome_resolver import resolve_outcomes
    resolve_outcomes(conn, horizon_days=15, dry_run=True)

    count = conn.execute("SELECT COUNT(*) FROM signal_outcomes").fetchone()[0]
    assert count == 0
```

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_outcome_resolver.py -v
```
Expected: `ModuleNotFoundError: No module named 'outcome_resolver'`

- [ ] **Step 3: Create `src/server/outcome_resolver.py`**

```python
"""
Outcome Resolver
================
Auto-labels technical_signals rows in signal_outcomes using stock_ohlcv.
Detects STOP_LOSS when intraday low crosses below stop_loss before horizon exit.

Run:  python outcome_resolver.py
      python outcome_resolver.py --horizon 5
      python outcome_resolver.py --dry-run
"""

import os, sys, sqlite3, datetime, argparse
from typing import Any

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

WIN_THRESHOLD  =  1.0   # > +1% = WIN
LOSS_THRESHOLD = -1.0   # < -1% = LOSS


def resolve_outcomes(
    conn: sqlite3.Connection,
    horizon_days: int = 15,
    dry_run: bool = False,
) -> dict[str, int]:
    today     = datetime.date.today()
    cutoff    = (today - datetime.timedelta(days=horizon_days)).isoformat()

    # Signals old enough that horizon has passed, not yet resolved
    pending = conn.execute("""
        SELECT ts.symbol, ts.date AS signal_date, ts.cmp AS entry_price,
               ts.signal_score, ts.signals_json,
               CAST(ts.stop_loss AS REAL) AS stop_loss
        FROM technical_signals ts
        WHERE ts.date <= ?
          AND NOT EXISTS (
              SELECT 1 FROM signal_outcomes so
              WHERE so.symbol = ts.symbol
                AND so.signal_date = ts.date
                AND so.horizon_days = ?
                AND so.outcome NOT IN ('PENDING', 'STOP_LOSS', 'WIN', 'LOSS', 'NEUTRAL')
          )
          AND NOT EXISTS (
              SELECT 1 FROM signal_outcomes so2
              WHERE so2.symbol = ts.symbol
                AND so2.signal_date = ts.date
                AND so2.horizon_days = ?
                AND so2.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          )
        ORDER BY ts.date DESC
        LIMIT 2000
    """, (cutoff, horizon_days, horizon_days)).fetchall()

    cols = ['symbol', 'signal_date', 'entry_price', 'signal_score', 'signals_json', 'stop_loss']
    rows = [dict(zip(cols, r)) for r in pending]

    if not rows:
        print(f"[OutcomeResolver] No pending signals to resolve (horizon={horizon_days}d).")
        return {'processed': 0, 'resolved': 0}

    print(f"[OutcomeResolver] {len(rows)} signals pending resolution.")
    resolved = 0

    upsert = """
        INSERT INTO signal_outcomes
            (symbol, signal_date, horizon_days, entry_price,
             check_date, exit_price, return_pct, outcome,
             signal_score, signals_json, computed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(symbol, signal_date, horizon_days) DO UPDATE SET
            check_date=excluded.check_date, exit_price=excluded.exit_price,
            return_pct=excluded.return_pct, outcome=excluded.outcome,
            computed_at=excluded.computed_at
    """

    for row in rows:
        sym          = row['symbol']
        signal_date  = row['signal_date']
        entry        = float(row['entry_price'] or 0)
        stop_loss    = row['stop_loss']
        if not entry:
            continue

        # Window: signal_date+1 to signal_date+horizon_days+5 (buffer)
        exit_target  = (datetime.date.fromisoformat(signal_date)
                        + datetime.timedelta(days=horizon_days)).isoformat()
        window_end   = (datetime.date.fromisoformat(signal_date)
                        + datetime.timedelta(days=horizon_days + 5)).isoformat()

        # Check for stop-loss hit (any intraday low <= stop_loss before exit date)
        outcome      = None
        exit_price   = None
        check_date   = None

        if stop_loss:
            sl_hit = conn.execute("""
                SELECT date, low FROM stock_ohlcv
                WHERE symbol = ? AND date > ? AND date <= ?
                  AND low <= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, signal_date, exit_target, stop_loss)).fetchone()

            if sl_hit:
                check_date = sl_hit[0]
                exit_price = float(stop_loss)
                return_pct = (exit_price - entry) / entry * 100
                outcome    = 'STOP_LOSS'

        # No stop-loss hit: find exit price at horizon date
        if outcome is None:
            exit_row = conn.execute("""
                SELECT date, close FROM stock_ohlcv
                WHERE symbol = ? AND date >= ?
                ORDER BY date ASC LIMIT 1
            """, (sym, exit_target)).fetchone()

            if exit_row:
                check_date = exit_row[0]
                exit_price = float(exit_row[1])
                return_pct = (exit_price - entry) / entry * 100
                outcome    = ('WIN'  if return_pct > WIN_THRESHOLD  else
                              'LOSS' if return_pct < LOSS_THRESHOLD else
                              'NEUTRAL')
            else:
                # OHLCV not available yet — mark PENDING
                outcome    = 'PENDING'
                return_pct = None

        if dry_run:
            print(f"  [DRY] {sym} {signal_date} → {outcome} "
                  f"({return_pct:.2f}% )" if return_pct is not None else
                  f"  [DRY] {sym} {signal_date} → {outcome}")
            continue

        conn.execute(upsert, (
            sym, signal_date, horizon_days, entry,
            check_date, exit_price,
            round(return_pct, 4) if return_pct is not None else None,
            outcome,
            row['signal_score'], row['signals_json'],
        ))
        if outcome != 'PENDING':
            resolved += 1

    if not dry_run:
        conn.commit()

    print(f"[OutcomeResolver] Resolved {resolved}/{len(rows)} signals.")
    return {'processed': len(rows), 'resolved': resolved}


def run(horizon_days: int = 15, dry_run: bool = False):
    conn = sqlite3.connect(DB_PATH)
    try:
        resolve_outcomes(conn, horizon_days=horizon_days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--horizon',  type=int, default=15)
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()
    run(horizon_days=args.horizon, dry_run=args.dry_run)
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_outcome_resolver.py -v
```
Expected:
```
PASSED tests/test_outcome_resolver.py::test_win_outcome
PASSED tests/test_outcome_resolver.py::test_stop_loss_outcome
PASSED tests/test_outcome_resolver.py::test_dry_run_writes_nothing
3 passed
```

- [ ] **Step 5: Smoke-test against real DB**

```bash
cd c:/Github/bharat-stock-intelligence
python src/server/outcome_resolver.py --dry-run --horizon 15
```
Expected: prints `[OutcomeResolver] N signals pending resolution.` then `[DRY]` lines (or "No pending signals" if none available yet).

- [ ] **Step 6: Commit**

```bash
git add src/server/outcome_resolver.py src/server/tests/
git commit -m "feat(ml): add outcome_resolver.py with STOP_LOSS detection"
```

---

## Task 3: `reward_engine.py` — EMA Reward/Penalty Propagation

**Files:**
- Create: `src/server/reward_engine.py`
- Create: `src/server/tests/test_reward_engine.py`

- [ ] **Step 1: Write tests first**

Create `src/server/tests/test_reward_engine.py`:

```python
import sqlite3, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def make_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE signal_outcomes (
            symbol TEXT, signal_date TEXT, horizon_days INTEGER,
            entry_price REAL, check_date TEXT, exit_price REAL,
            return_pct REAL, outcome TEXT, signal_score INTEGER,
            signals_json TEXT, computed_at TEXT,
            PRIMARY KEY (symbol, signal_date, horizon_days)
        );
        CREATE TABLE technical_signals (
            symbol TEXT, date TEXT, nifty_regime TEXT, signals_json TEXT,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE nse_stocks (symbol TEXT PRIMARY KEY, sector TEXT);
        CREATE TABLE signal_type_weights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            signal_type TEXT NOT NULL, regime TEXT NOT NULL,
            sector TEXT NOT NULL DEFAULT 'ALL',
            weight REAL NOT NULL DEFAULT 1.0,
            sample_count INTEGER NOT NULL DEFAULT 0,
            last_updated TEXT NOT NULL,
            UNIQUE(signal_type, regime, sector)
        );
        CREATE TABLE feature_importance_log (
            id INTEGER PRIMARY KEY, model_id INTEGER,
            model_name TEXT, computed_at TEXT,
            feature_name TEXT, importance REAL, rank_position INTEGER
        );
    """)
    return conn

def insert_outcome(conn, symbol, date, return_pct, outcome, regime='BULL',
                   signals='[{"type":"RSI_DIVERGENCE"}]', sector='IT'):
    conn.execute("""
        INSERT OR IGNORE INTO signal_outcomes
        VALUES (?,?,15,100.0,?,?,?,?,6,?,CURRENT_TIMESTAMP)
    """, (symbol, date, date, 100*(1+return_pct/100), return_pct, outcome, signals))
    conn.execute("""
        INSERT OR IGNORE INTO technical_signals VALUES (?,?,?,?)
    """, (symbol, date, regime, signals))
    conn.execute("INSERT OR IGNORE INTO nse_stocks VALUES (?,?)", (symbol, sector))
    conn.commit()

def test_win_increases_weight():
    conn = make_db()
    insert_outcome(conn, 'INFY', '2024-01-01', 5.0, 'WIN')

    from reward_engine import update_weights
    update_weights(conn, dry_run=False)

    row = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='RSI_DIVERGENCE' AND regime='BULL' AND sector='IT'
    """).fetchone()
    assert row is not None
    assert row[0] > 1.0, f"Expected weight > 1.0, got {row[0]}"

def test_stop_loss_decreases_weight_more_than_loss():
    conn = make_db()
    # LOSS at -3%: reward = -3/15*10*1.5 = -3.0
    insert_outcome(conn, 'TCS', '2024-01-02', -3.0, 'LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    from reward_engine import update_weights
    update_weights(conn, dry_run=False)
    loss_weight = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='MACD_CROSSOVER' AND regime='BULL' AND sector='IT'
    """).fetchone()[0]

    conn2 = make_db()
    # STOP_LOSS at -3%: reward = -3/15*10*2.0 = -4.0 (more negative)
    insert_outcome(conn2, 'WIPRO', '2024-01-02', -3.0, 'STOP_LOSS',
                   signals='[{"type":"MACD_CROSSOVER"}]', sector='IT')
    update_weights(conn2, dry_run=False)
    sl_weight = conn2.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='MACD_CROSSOVER' AND regime='BULL' AND sector='IT'
    """).fetchone()[0]

    assert sl_weight < loss_weight, "STOP_LOSS should reduce weight more than plain LOSS"

def test_weight_clamped_to_floor():
    conn = make_db()
    # Pre-seed with a weight near floor
    conn.execute("""
        INSERT INTO signal_type_weights
        (signal_type, regime, sector, weight, sample_count, last_updated)
        VALUES ('RSI_DIVERGENCE','BULL','ALL',0.32,'5',CURRENT_TIMESTAMP)
    """)
    conn.commit()
    # Massive loss to try to push below floor
    insert_outcome(conn, 'X', '2024-01-01', -20.0, 'STOP_LOSS')
    from reward_engine import update_weights
    update_weights(conn, dry_run=False)
    row = conn.execute("""
        SELECT weight FROM signal_type_weights
        WHERE signal_type='RSI_DIVERGENCE' AND regime='BULL'
    """).fetchone()
    assert row[0] >= 0.3, f"Weight should not go below 0.3, got {row[0]}"

def test_dry_run_no_writes():
    conn = make_db()
    insert_outcome(conn, 'HDFCBANK', '2024-01-01', 8.0, 'WIN',
                   signals='[{"type":"GOLDEN_CROSS"}]')
    from reward_engine import update_weights
    update_weights(conn, dry_run=True)
    count = conn.execute("SELECT COUNT(*) FROM signal_type_weights").fetchone()[0]
    assert count == 0
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_reward_engine.py -v
```
Expected: `ModuleNotFoundError: No module named 'reward_engine'`

- [ ] **Step 3: Create `src/server/reward_engine.py`**

```python
"""
Reward Engine
=============
Computes risk-adjusted rewards from resolved signal_outcomes and maintains
EMA-smoothed weight multipliers per (signal_type, regime, sector) in
signal_type_weights.  scoring_engine.py reads these at startup.

Reward formula:
  WIN:       (return_pct / horizon_days) × 10
  LOSS:      (return_pct / horizon_days) × 10 × 1.5
  NEUTRAL:   -0.05
  STOP_LOSS: (return_pct / horizon_days) × 10 × 2.0

EMA update (α = 0.15):
  new_weight = old_weight × 0.85 + reward × 0.15
  clamped to [0.3, 2.0]

Run:  python reward_engine.py
      python reward_engine.py --dry-run
      python reward_engine.py --days 30   # only process outcomes from last N days
"""

import os, sys, json, sqlite3, datetime, argparse
from typing import Optional

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

EMA_ALPHA   = 0.15
WEIGHT_MIN  = 0.3
WEIGHT_MAX  = 2.0
MIN_SAMPLES = 3   # skip signal types with fewer than this many outcomes

LOSS_MULTIPLIER     = 1.5
STOP_LOSS_MULTIPLIER = 2.0
NEUTRAL_REWARD      = -0.05


def _compute_reward(return_pct: float, horizon_days: int, outcome: str) -> float:
    base = (return_pct / max(horizon_days, 1)) * 10
    if outcome == 'WIN':
        return base
    if outcome == 'LOSS':
        return base * LOSS_MULTIPLIER
    if outcome == 'STOP_LOSS':
        return base * STOP_LOSS_MULTIPLIER
    return NEUTRAL_REWARD   # NEUTRAL


def _parse_signal_types(signals_json: Optional[str]) -> list[str]:
    try:
        return [s['type'] for s in json.loads(signals_json or '[]')
                if isinstance(s, dict) and 'type' in s]
    except Exception:
        return []


def _get_sector(conn: sqlite3.Connection, symbol: str) -> str:
    row = conn.execute(
        "SELECT sector FROM nse_stocks WHERE symbol = ?", (symbol,)
    ).fetchone()
    return (row[0] or 'OTHER') if row else 'OTHER'


def _get_regime(conn: sqlite3.Connection, symbol: str, date: str) -> str:
    row = conn.execute(
        "SELECT nifty_regime FROM technical_signals WHERE symbol = ? AND date = ?",
        (symbol, date),
    ).fetchone()
    return (row[0] or 'SIDEWAYS') if row else 'SIDEWAYS'


def _get_current_weight(
    conn: sqlite3.Connection, signal_type: str, regime: str, sector: str
) -> tuple[float, int]:
    row = conn.execute("""
        SELECT weight, sample_count FROM signal_type_weights
        WHERE signal_type = ? AND regime = ? AND sector = ?
    """, (signal_type, regime, sector)).fetchone()
    return (row[0], row[1]) if row else (1.0, 0)


def _upsert_weight(
    conn: sqlite3.Connection, signal_type: str, regime: str, sector: str,
    new_weight: float, sample_count: int,
):
    now = datetime.datetime.now().isoformat()
    conn.execute("""
        INSERT INTO signal_type_weights
            (signal_type, regime, sector, weight, sample_count, last_updated)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(signal_type, regime, sector) DO UPDATE SET
            weight=excluded.weight,
            sample_count=excluded.sample_count,
            last_updated=excluded.last_updated
    """, (signal_type, regime, sector, round(new_weight, 6), sample_count, now))


def update_weights(
    conn: sqlite3.Connection,
    days: Optional[int] = None,
    dry_run: bool = False,
) -> dict[str, int]:
    cutoff = ''
    if days:
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).strftime('%Y-%m-%d')

    query = """
        SELECT symbol, signal_date, horizon_days, return_pct, outcome, signals_json
        FROM signal_outcomes
        WHERE outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND return_pct IS NOT NULL
    """
    params: tuple = ()
    if cutoff:
        query += " AND signal_date >= ?"
        params = (cutoff,)

    rows = conn.execute(query, params).fetchall()
    if not rows:
        print("[RewardEngine] No resolved outcomes found.")
        return {'processed': 0, 'updated': 0}

    print(f"[RewardEngine] Processing {len(rows)} resolved outcomes...")

    # Accumulate rewards per (signal_type, regime, sector)
    # key → list of rewards
    reward_map: dict[tuple, list[float]] = {}

    for symbol, signal_date, horizon_days, return_pct, outcome, signals_json in rows:
        reward     = _compute_reward(float(return_pct), int(horizon_days), outcome)
        regime     = _get_regime(conn, symbol, signal_date)
        sector     = _get_sector(conn, symbol)
        sig_types  = _parse_signal_types(signals_json)

        for st in sig_types:
            key = (st, regime, sector)
            reward_map.setdefault(key, []).append(reward)

    updated = 0
    for (signal_type, regime, sector), rewards in reward_map.items():
        if len(rewards) < MIN_SAMPLES:
            continue  # not enough data to be reliable
        avg_reward                = sum(rewards) / len(rewards)
        old_weight, sample_count  = _get_current_weight(conn, signal_type, regime, sector)
        new_weight                = old_weight * (1 - EMA_ALPHA) + avg_reward * EMA_ALPHA
        new_weight                = max(WEIGHT_MIN, min(WEIGHT_MAX, new_weight))
        new_count                 = sample_count + len(rewards)

        if dry_run:
            print(f"  [DRY] {signal_type}|{regime}|{sector}: "
                  f"{old_weight:.4f} → {new_weight:.4f} (n={len(rewards)})")
            continue

        _upsert_weight(conn, signal_type, regime, sector, new_weight, new_count)
        updated += 1

    if not dry_run:
        conn.commit()

    print(f"[RewardEngine] Updated {updated} signal_type_weights rows.")
    return {'processed': len(rows), 'updated': updated}


def run(days: Optional[int] = None, dry_run: bool = False):
    conn = sqlite3.connect(DB_PATH)
    try:
        update_weights(conn, days=days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--days',    type=int, default=None,
                        help='Only process outcomes from last N days')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(days=args.days, dry_run=args.dry_run)
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_reward_engine.py -v
```
Expected:
```
PASSED tests/test_reward_engine.py::test_win_increases_weight
PASSED tests/test_reward_engine.py::test_stop_loss_decreases_weight_more_than_loss
PASSED tests/test_reward_engine.py::test_weight_clamped_to_floor
PASSED tests/test_reward_engine.py::test_dry_run_no_writes
4 passed
```

- [ ] **Step 5: Smoke-test against real DB**

```bash
cd c:/Github/bharat-stock-intelligence
python src/server/reward_engine.py --dry-run
```
Expected: `[RewardEngine] Processing N resolved outcomes...` or `No resolved outcomes found.`

- [ ] **Step 6: Commit**

```bash
git add src/server/reward_engine.py src/server/tests/test_reward_engine.py
git commit -m "feat(ml): add reward_engine.py with EMA reward/penalty propagation"
```

---

## Task 4: `rl_agent.py` — Q-Learning Meta-Controller

**Files:**
- Create: `src/server/rl_agent.py`
- Create: `src/server/tests/test_rl_agent.py`

- [ ] **Step 1: Write tests first**

Create `src/server/tests/test_rl_agent.py`:

```python
import sqlite3, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def make_db():
    conn = sqlite3.connect(':memory:')
    conn.executescript("""
        CREATE TABLE rl_q_table (
            state_key TEXT NOT NULL, action TEXT NOT NULL,
            q_value REAL NOT NULL DEFAULT 0.0,
            visit_count INTEGER NOT NULL DEFAULT 0,
            last_updated TEXT NOT NULL,
            PRIMARY KEY (state_key, action)
        );
        CREATE TABLE rl_episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL, state_key TEXT NOT NULL,
            action_taken TEXT NOT NULL, reward REAL,
            epsilon REAL, notes TEXT
        );
    """)
    return conn

def test_get_state_key():
    from rl_agent import get_state_key
    assert get_state_key('BULL', 'IT', 8)   == 'BULL_IT_HIGH'
    assert get_state_key('BEAR', 'BANK', 4) == 'BEAR_BANK_MED'
    assert get_state_key('SIDEWAYS', 'PHARMA', 2) == 'SIDEWAYS_PHARMA_LOW'

def test_get_sector_bucket():
    from rl_agent import get_sector_bucket
    assert get_sector_bucket('Information Technology') == 'IT'
    assert get_sector_bucket('Banking')                == 'BANK'
    assert get_sector_bucket('Pharmaceuticals')        == 'PHARMA'
    assert get_sector_bucket('Textile')                == 'OTHER'
    assert get_sector_bucket(None)                     == 'OTHER'

def test_get_score_bucket():
    from rl_agent import get_score_bucket
    assert get_score_bucket(3)  == 'LOW'
    assert get_score_bucket(5)  == 'LOW'
    assert get_score_bucket(6)  == 'MED'
    assert get_score_bucket(7)  == 'MED'
    assert get_score_bucket(8)  == 'HIGH'
    assert get_score_bucket(10) == 'HIGH'

def test_q_learning_update_increases_q():
    from rl_agent import q_update, get_q, set_q
    conn = make_db()
    state  = 'BULL_IT_HIGH'
    action = 'AGGRESSIVE'
    # Initial Q = 0, reward = 2.0 (positive alpha)
    old_q  = get_q(conn, state, action)
    assert old_q == 0.0
    new_q  = q_update(old_q=old_q, reward=2.0, next_max_q=0.0, alpha=0.1, gamma=0.85)
    set_q(conn, state, action, new_q)
    assert get_q(conn, state, action) > 0.0

def test_q_learning_negative_reward_decreases_q():
    from rl_agent import q_update
    q_after_good = q_update(old_q=1.0, reward=-3.0, next_max_q=0.0, alpha=0.1, gamma=0.85)
    assert q_after_good < 1.0

def test_get_policy_returns_valid_action():
    from rl_agent import get_policy, ACTIONS
    conn = make_db()
    action = get_policy(conn, 'BULL_IT_HIGH', epsilon=0.0)
    assert action in ACTIONS

def test_get_multipliers_returns_dict():
    from rl_agent import get_multipliers, ACTIONS
    for action in ACTIONS:
        m = get_multipliers(action)
        assert isinstance(m, dict)
        assert len(m) > 0
        for k, v in m.items():
            assert isinstance(k, str)
            assert 0.5 <= v <= 2.0, f"{action} multiplier {k}={v} out of range"
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_rl_agent.py -v
```
Expected: `ModuleNotFoundError: No module named 'rl_agent'`

- [ ] **Step 3: Create `src/server/rl_agent.py`**

```python
"""
RL Meta-Controller (Tabular Q-Learning)
========================================
State:  (nifty_regime × sector_bucket × score_bucket) = 54 discrete states
Action: AGGRESSIVE | CONSERVATIVE | BALANCED | SECTOR_FOCUSED
Reward: trade_return_pct - nifty_return_pct  (alpha)

Q-update: Q(s,a) ← Q(s,a) + α × [r + γ × max_a' Q(s',a') − Q(s,a)]

Modes:
  --update   : run daily Q-learning update from resolved episodes
  --inspect  : print current Q-table and policy per state
  --dry-run  : print updates without writing

Used by scoring_engine.py: call get_policy(conn, state_key) to get action,
then get_multipliers(action) to get per-signal-type score multipliers.
"""

import os, sys, json, sqlite3, datetime, argparse, random
from typing import Optional

DB_PATH   = os.path.join(os.getcwd(), 'database.sqlite')

# ── Hyperparameters ───────────────────────────────────────────────────────────
ALPHA        = 0.10   # learning rate
GAMMA        = 0.85   # discount factor
EPSILON_INIT = 0.30   # initial exploration rate
EPSILON_MIN  = 0.05   # floor
EPSILON_DECAY = 0.985 # per daily update

# ── State space ───────────────────────────────────────────────────────────────
REGIMES       = ['BULL', 'SIDEWAYS', 'BEAR']
SCORE_BUCKETS = ['LOW', 'MED', 'HIGH']  # 3-5, 6-7, 8-10
SECTOR_MAP    = {
    'information technology': 'IT',
    'it':                      'IT',
    'technology':              'IT',
    'banking':                 'BANK',
    'bank':                    'BANK',
    'financial services':      'BANK',
    'pharmaceuticals':         'PHARMA',
    'pharma':                  'PHARMA',
    'healthcare':              'PHARMA',
    'automobile':              'AUTO',
    'auto':                    'AUTO',
    'energy':                  'ENERGY',
    'oil':                     'ENERGY',
    'power':                   'ENERGY',
}

# ── Actions ───────────────────────────────────────────────────────────────────
ACTIONS = ['AGGRESSIVE', 'CONSERVATIVE', 'BALANCED', 'SECTOR_FOCUSED']

# Per-action multipliers: signal_type → float
# Only non-1.0 entries are listed; all others default to 1.0
_MULTIPLIERS: dict[str, dict[str, float]] = {
    'AGGRESSIVE': {
        'RSI_DIVERGENCE':      1.5,
        'RESISTANCE_BREAKOUT': 1.5,
        'WEEK_52_BREAKOUT':    1.5,
        'MACD_CROSSOVER':      1.5,
        'EMA_BULL_STACK':      1.5,
        'OVERSOLD_RECOVERY':   0.7,
        'BB_COMPRESSION':      0.7,
    },
    'CONSERVATIVE': {
        'RSI_DIVERGENCE':      0.8,
        'HIDDEN_DIVERGENCE':   0.8,
        'RESISTANCE_BREAKOUT': 0.8,
        'MACD_CROSSOVER':      0.8,
        'BB_COMPRESSION':      0.8,
        'GOLDEN_CROSS':        0.8,
        'OVERSOLD_RECOVERY':   0.8,
        'EMA_BULL_STACK':      0.8,
        'WEEK_52_BREAKOUT':    0.8,
        'BULLISH_ENGULFING':   0.8,
        'SUPERTREND_CROSS':    0.8,
        'NR7_COMPRESSION':     0.8,
        'VOLUME_ACCUMULATION': 0.8,
        'NEAR_52W_HIGH':       0.8,
        'CONSECUTIVE_STRENGTH':0.8,
        'ATR_CONTRACTION':     0.8,
        'PCR_EXTREME':         0.8,
    },
    'BALANCED': {},  # all 1.0 — no adjustment
    'SECTOR_FOCUSED': {
        # Sector-specific amplification applied dynamically in scoring_engine
        # Default non-sector signals get a mild discount
        'RSI_DIVERGENCE':      1.4,
        'EMA_BULL_STACK':      1.4,
        'GOLDEN_CROSS':        1.4,
        'BB_COMPRESSION':      0.8,
        'ATR_CONTRACTION':     0.8,
    },
}


# ── State helpers ─────────────────────────────────────────────────────────────

def get_sector_bucket(sector: Optional[str]) -> str:
    if not sector:
        return 'OTHER'
    key = sector.strip().lower()
    return SECTOR_MAP.get(key, 'OTHER')


def get_score_bucket(score: int) -> str:
    if score <= 5:
        return 'LOW'
    if score <= 7:
        return 'MED'
    return 'HIGH'


def get_state_key(regime: str, sector_or_bucket: str, score: int) -> str:
    regime_clean = regime if regime in REGIMES else 'SIDEWAYS'
    # Accept either raw sector name or already-bucketed value
    if sector_or_bucket in ('IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'OTHER'):
        sector_bucket = sector_or_bucket
    else:
        sector_bucket = get_sector_bucket(sector_or_bucket)
    score_bucket  = get_score_bucket(score)
    return f"{regime_clean}_{sector_bucket}_{score_bucket}"


# ── Q-table access ────────────────────────────────────────────────────────────

def get_q(conn: sqlite3.Connection, state_key: str, action: str) -> float:
    row = conn.execute(
        "SELECT q_value FROM rl_q_table WHERE state_key=? AND action=?",
        (state_key, action),
    ).fetchone()
    return float(row[0]) if row else 0.0


def set_q(conn: sqlite3.Connection, state_key: str, action: str, value: float):
    now = datetime.datetime.now().isoformat()
    conn.execute("""
        INSERT INTO rl_q_table (state_key, action, q_value, visit_count, last_updated)
        VALUES (?,?,?,1,?)
        ON CONFLICT(state_key, action) DO UPDATE SET
            q_value=excluded.q_value,
            visit_count=visit_count+1,
            last_updated=excluded.last_updated
    """, (state_key, action, round(value, 6), now))


def get_max_q(conn: sqlite3.Connection, state_key: str) -> float:
    rows = conn.execute(
        "SELECT q_value FROM rl_q_table WHERE state_key=?", (state_key,)
    ).fetchall()
    return max((float(r[0]) for r in rows), default=0.0)


# ── Q-learning update ─────────────────────────────────────────────────────────

def q_update(old_q: float, reward: float, next_max_q: float,
             alpha: float = ALPHA, gamma: float = GAMMA) -> float:
    return old_q + alpha * (reward + gamma * next_max_q - old_q)


# ── Policy ────────────────────────────────────────────────────────────────────

def get_policy(conn: sqlite3.Connection, state_key: str,
               epsilon: float = 0.0) -> str:
    if random.random() < epsilon:
        return random.choice(ACTIONS)
    q_values = {a: get_q(conn, state_key, a) for a in ACTIONS}
    return max(q_values, key=lambda a: q_values[a])


def get_multipliers(action: str) -> dict[str, float]:
    return dict(_MULTIPLIERS.get(action, {}))


# ── Episode logging ───────────────────────────────────────────────────────────

def log_episode(conn: sqlite3.Connection, date: str, state_key: str,
                action: str, epsilon: float):
    conn.execute("""
        INSERT INTO rl_episodes (date, state_key, action_taken, epsilon)
        VALUES (?,?,?,?)
    """, (date, state_key, action, round(epsilon, 4)))
    conn.commit()


# ── Daily update ──────────────────────────────────────────────────────────────

def _load_epsilon(conn: sqlite3.Connection) -> float:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key='rl_epsilon'"
    ).fetchone()
    return float(row[0]) if row else EPSILON_INIT


def _save_epsilon(conn: sqlite3.Connection, epsilon: float):
    conn.execute("""
        INSERT INTO app_settings (key, value, updatedAt)
        VALUES ('rl_epsilon', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=CURRENT_TIMESTAMP
    """, (str(round(epsilon, 6)),))


def _get_nifty_return(conn: sqlite3.Connection, date: str) -> float:
    row = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date = ?
        ORDER BY date DESC LIMIT 1
    """, (date,)).fetchone()
    if not row:
        return 0.0
    prev = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date < ?
        ORDER BY date DESC LIMIT 1
    """, (date,)).fetchone()
    if not row or not prev:
        return 0.0
    return (float(row[0]) - float(prev[0])) / float(prev[0]) * 100


def daily_update(conn: sqlite3.Connection, dry_run: bool = False) -> dict[str, int]:
    today = datetime.date.today().isoformat()

    # Load episodes from today with no reward yet
    episodes = conn.execute("""
        SELECT id, date, state_key, action_taken
        FROM rl_episodes
        WHERE date = ? AND reward IS NULL
    """, (today,)).fetchall()

    if not episodes:
        print("[RLAgent] No episodes to update today.")
        return {'episodes': 0, 'updated': 0}

    print(f"[RLAgent] Updating {len(episodes)} episodes...")
    epsilon = _load_epsilon(conn)

    updated = 0
    for ep_id, ep_date, state_key, action in episodes:
        # Find resolved signal_outcomes on ep_date in this state (approximate reward)
        # Parse state_key to get regime + sector_bucket + score_bucket
        parts = state_key.split('_')
        regime = parts[0] if parts else 'SIDEWAYS'

        outcomes = conn.execute("""
            SELECT so.return_pct FROM signal_outcomes so
            JOIN technical_signals ts ON ts.symbol=so.symbol AND ts.date=so.signal_date
            WHERE so.signal_date = ?
              AND so.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
              AND ts.nifty_regime = ?
        """, (ep_date, regime)).fetchall()

        if not outcomes:
            continue

        # Compute alpha reward
        nifty_ret = _get_nifty_return(conn, ep_date)
        avg_return = sum(float(r[0]) for r in outcomes) / len(outcomes)
        reward     = avg_return - nifty_ret

        # Q-learning update
        next_state = state_key  # approximate: next state ≈ current state
        next_max   = get_max_q(conn, next_state)
        old_q      = get_q(conn, state_key, action)
        new_q      = q_update(old_q, reward, next_max)

        if dry_run:
            print(f"  [DRY] state={state_key} action={action} "
                  f"reward={reward:.3f} Q: {old_q:.4f}→{new_q:.4f}")
            updated += 1
            continue

        set_q(conn, state_key, action, new_q)
        conn.execute("UPDATE rl_episodes SET reward=? WHERE id=?",
                     (round(reward, 4), ep_id))
        updated += 1

    # Decay epsilon
    new_epsilon = max(EPSILON_MIN, epsilon * EPSILON_DECAY)
    if not dry_run:
        _save_epsilon(conn, new_epsilon)
        conn.commit()

    print(f"[RLAgent] Updated {updated}/{len(episodes)} episodes. "
          f"ε={epsilon:.4f}→{new_epsilon:.4f}")
    return {'episodes': len(episodes), 'updated': updated}


def inspect_policy(conn: sqlite3.Connection):
    print("\nCurrent RL Policy (best action per state):\n")
    print(f"{'State':<30} {'Action':<18} {'Q-value':>8}")
    print("-" * 60)
    for regime in REGIMES:
        for sector in ['IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'OTHER']:
            for bucket in SCORE_BUCKETS:
                sk     = f"{regime}_{sector}_{bucket}"
                action = get_policy(conn, sk, epsilon=0.0)
                best_q = get_q(conn, sk, action)
                print(f"{sk:<30} {action:<18} {best_q:>8.4f}")


def run(mode: str = 'update', dry_run: bool = False):
    conn = sqlite3.connect(DB_PATH)
    try:
        if mode == 'inspect':
            inspect_policy(conn)
        else:
            daily_update(conn, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--update',   dest='mode', action='store_const', const='update',
                        default='update')
    parser.add_argument('--inspect',  dest='mode', action='store_const', const='inspect')
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()
    run(mode=args.mode, dry_run=args.dry_run)
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_rl_agent.py -v
```
Expected:
```
PASSED tests/test_rl_agent.py::test_get_state_key
PASSED tests/test_rl_agent.py::test_get_sector_bucket
PASSED tests/test_rl_agent.py::test_get_score_bucket
PASSED tests/test_rl_agent.py::test_q_learning_update_increases_q
PASSED tests/test_rl_agent.py::test_q_learning_negative_reward_decreases_q
PASSED tests/test_rl_agent.py::test_get_policy_returns_valid_action
PASSED tests/test_rl_agent.py::test_get_multipliers_returns_dict
7 passed
```

- [ ] **Step 5: Smoke-test inspect mode**

```bash
cd c:/Github/bharat-stock-intelligence
python src/server/rl_agent.py --inspect
```
Expected: prints Q-table grid. All Q-values will be 0.0 initially — that's correct.

- [ ] **Step 6: Commit**

```bash
git add src/server/rl_agent.py src/server/tests/test_rl_agent.py
git commit -m "feat(ml): add rl_agent.py Q-learning meta-controller"
```

---

## Task 5: `backtest_optimizer.py` — Grid Search → Optimal Parameters

**Files:**
- Create: `src/server/backtest_optimizer.py`
- Create: `src/server/tests/test_backtest_optimizer.py`

- [ ] **Step 1: Write tests first**

Create `src/server/tests/test_backtest_optimizer.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def test_find_best_config_returns_highest_sharpe():
    from backtest_optimizer import find_best_config

    # Simulate grid results: list of (config, stats) dicts
    results = [
        ({'min_score': 3, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 0.8, 'win_rate': 0.52, 'max_drawdown_pct': -15.0, 'total_trades': 50}),
        ({'min_score': 5, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 1.2, 'win_rate': 0.58, 'max_drawdown_pct': -12.0, 'total_trades': 30}),
        ({'min_score': 7, 'horizon_days': 10, 'stop_loss_pct': 5, 'max_positions': 10},
         {'sharpe_ratio': 0.5, 'win_rate': 0.60, 'max_drawdown_pct': -8.0, 'total_trades': 15}),
    ]
    best = find_best_config(results)
    assert best['config']['min_score'] == 5
    assert best['stats']['sharpe_ratio'] == 1.2

def test_find_best_config_respects_constraints():
    from backtest_optimizer import find_best_config

    results = [
        # High Sharpe but fails win_rate constraint
        ({'min_score': 3, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 2.0, 'win_rate': 0.30, 'max_drawdown_pct': -15.0, 'total_trades': 100}),
        # Lower Sharpe but passes all constraints
        ({'min_score': 5, 'horizon_days': 15, 'stop_loss_pct': 7, 'max_positions': 20},
         {'sharpe_ratio': 1.1, 'win_rate': 0.50, 'max_drawdown_pct': -20.0, 'total_trades': 40}),
    ]
    best = find_best_config(results)
    assert best['config']['min_score'] == 5, "Should skip result failing win_rate constraint"

def test_find_best_config_none_if_all_fail_constraints():
    from backtest_optimizer import find_best_config

    results = [
        ({'min_score': 3}, {'sharpe_ratio': 1.5, 'win_rate': 0.20,
                            'max_drawdown_pct': -15.0, 'total_trades': 5}),
    ]
    best = find_best_config(results)
    assert best is None

def test_should_update_returns_true_on_improvement():
    from backtest_optimizer import should_update

    assert should_update(current_sharpe=1.0, new_sharpe=1.1) is True   # 10% better
    assert should_update(current_sharpe=1.0, new_sharpe=1.04) is False  # only 4%
    assert should_update(current_sharpe=0.0, new_sharpe=0.5) is True   # baseline 0
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_backtest_optimizer.py -v
```
Expected: `ModuleNotFoundError: No module named 'backtest_optimizer'`

- [ ] **Step 3: Create `src/server/backtest_optimizer.py`**

```python
"""
Backtest Optimizer
==================
Grid search over (min_score, horizon_days, stop_loss_pct, max_positions).
Finds config maximising Sharpe ratio subject to constraints:
  win_rate >= 0.45, max_drawdown_pct >= -25.0, total_trades >= 20

Writes optimal params to app_settings:
  optimal_min_score, optimal_horizon_days, optimal_stop_loss_pct

Only updates app_settings if new Sharpe >= current × 1.05.
Uses the most recent `--window` days of data (default 365).

Run:  python backtest_optimizer.py
      python backtest_optimizer.py --window 365 --dry-run
"""

import os, sys, sqlite3, json, datetime, argparse, itertools
from typing import Optional

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

PARAM_GRID = {
    'min_score':     [3, 4, 5, 6, 7],
    'horizon_days':  [7, 10, 15, 20, 30],
    'stop_loss_pct': [5, 7, 10, 12],
    'max_positions': [10, 15, 20],
}

CONSTRAINT_WIN_RATE     = 0.45
CONSTRAINT_MAX_DRAWDOWN = -25.0
CONSTRAINT_MIN_TRADES   = 20
UPDATE_THRESHOLD        = 1.05   # new Sharpe must be >= current × 1.05


def find_best_config(
    results: list[dict],
) -> Optional[dict]:
    """Given list of {config, stats} dicts, return the one with highest Sharpe
    that satisfies all constraints. Returns None if none pass."""
    valid = [
        r for r in results
        if (r['stats'].get('win_rate', 0) >= CONSTRAINT_WIN_RATE
            and r['stats'].get('max_drawdown_pct', -999) >= CONSTRAINT_MAX_DRAWDOWN
            and r['stats'].get('total_trades', 0) >= CONSTRAINT_MIN_TRADES)
    ]
    if not valid:
        return None
    return max(valid, key=lambda r: r['stats'].get('sharpe_ratio', 0.0))


def should_update(current_sharpe: float, new_sharpe: float) -> bool:
    if current_sharpe <= 0:
        return new_sharpe > 0
    return new_sharpe >= current_sharpe * UPDATE_THRESHOLD


def _get_current_sharpe(conn: sqlite3.Connection) -> float:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key='optimal_sharpe'"
    ).fetchone()
    return float(row[0]) if row else 0.0


def _write_optimal_params(conn: sqlite3.Connection, config: dict, sharpe: float):
    now = datetime.datetime.now().isoformat()
    pairs = [
        ('optimal_min_score',      str(config['min_score'])),
        ('optimal_horizon_days',   str(config['horizon_days'])),
        ('optimal_stop_loss_pct',  str(config['stop_loss_pct'])),
        ('optimal_sharpe',         str(round(sharpe, 4))),
    ]
    for key, value in pairs:
        conn.execute("""
            INSERT INTO app_settings (key, value, updatedAt)
            VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt
        """, (key, value, now))
    conn.commit()


def run_grid_search(
    conn: sqlite3.Connection,
    window_days: int = 365,
    dry_run: bool = False,
) -> Optional[dict]:
    # Lazy import to avoid loading heavy deps unless needed
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from backtester import Backtester

    end   = datetime.date.today().isoformat()
    start = (datetime.date.today() - datetime.timedelta(days=window_days)).isoformat()

    keys   = list(PARAM_GRID.keys())
    combos = list(itertools.product(*[PARAM_GRID[k] for k in keys]))
    total  = len(combos)
    print(f"[BtOptimizer] Grid search: {total} combinations  {start} → {end}")

    results = []
    bt = Backtester()

    try:
        for i, combo in enumerate(combos, 1):
            cfg = dict(zip(keys, combo))
            print(f"  [{i}/{total}] {cfg} ...", end=' ', flush=True)

            try:
                stats = bt.run(
                    start=start, end=end,
                    horizon_days=cfg['horizon_days'],
                    min_score=cfg['min_score'],
                    max_positions=cfg['max_positions'],
                    run_name=f"opt_{i}",
                )
            except Exception as e:
                print(f"ERROR: {e}")
                continue

            if not stats:
                print("no trades")
                continue

            print(f"Sharpe={stats.get('sharpe_ratio',0):.3f}  "
                  f"WR={stats.get('win_rate',0):.2f}  "
                  f"DD={stats.get('max_drawdown_pct',0):.1f}%")
            results.append({'config': cfg, 'stats': stats})

    finally:
        bt.close()

    if not results:
        print("[BtOptimizer] No results — cannot optimise.")
        return None

    best = find_best_config(results)
    if not best:
        print("[BtOptimizer] No config passed all constraints.")
        return None

    print(f"\n[BtOptimizer] Best config: {best['config']}")
    print(f"  Sharpe={best['stats']['sharpe_ratio']:.4f}  "
          f"CAGR={best['stats'].get('cagr_pct',0):.2f}%  "
          f"WR={best['stats']['win_rate']:.2f}")

    current_sharpe = _get_current_sharpe(conn)
    new_sharpe     = best['stats']['sharpe_ratio']

    if dry_run:
        print(f"[BtOptimizer] [DRY] Would update app_settings "
              f"(current Sharpe={current_sharpe:.4f}, new={new_sharpe:.4f})")
        return best

    if should_update(current_sharpe, new_sharpe):
        _write_optimal_params(conn, best['config'], new_sharpe)
        print(f"[BtOptimizer] app_settings updated. "
              f"Sharpe {current_sharpe:.4f} → {new_sharpe:.4f}")
    else:
        print(f"[BtOptimizer] No update: new Sharpe {new_sharpe:.4f} < "
              f"current {current_sharpe:.4f} × {UPDATE_THRESHOLD}")

    return best


def run(window_days: int = 365, dry_run: bool = False):
    conn = sqlite3.connect(DB_PATH)
    try:
        run_grid_search(conn, window_days=window_days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--window',  type=int, default=365,
                        help='Rolling window in days (default: 365)')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(window_days=args.window, dry_run=args.dry_run)
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/test_backtest_optimizer.py -v
```
Expected:
```
PASSED tests/test_backtest_optimizer.py::test_find_best_config_returns_highest_sharpe
PASSED tests/test_backtest_optimizer.py::test_find_best_config_respects_constraints
PASSED tests/test_backtest_optimizer.py::test_find_best_config_none_if_all_fail_constraints
PASSED tests/test_backtest_optimizer.py::test_should_update_returns_true_on_improvement
4 passed
```

- [ ] **Step 5: Smoke-test dry-run (fast)**

```bash
cd c:/Github/bharat-stock-intelligence
python src/server/backtest_optimizer.py --dry-run --window 30
```
Expected: runs combinations, prints `[DRY] Would update app_settings` or "No results".

- [ ] **Step 6: Commit**

```bash
git add src/server/backtest_optimizer.py src/server/tests/test_backtest_optimizer.py
git commit -m "feat(ml): add backtest_optimizer.py grid search → optimal params"
```

---

## Task 6: `scoring_engine.py` — Integrate Reward Weights + RL Policy

**Files:**
- Modify: `src/server/scoring_engine.py`

The `AlphaQuantScoringEngine.__init__` already calls `self._load_optimised_weights()`. We add two more load calls and a method that applies multipliers during scoring.

- [ ] **Step 1: Add `_load_signal_type_weights` method**

In `src/server/scoring_engine.py`, after the `_load_optimised_weights` method (after line 80), add:

```python
    def _load_signal_type_weights(self):
        """Load per-(signal_type, regime, sector) EMA reward weights from DB."""
        self._signal_type_weights: dict[tuple, float] = {}
        try:
            with self.engine.connect() as conn:
                rows = conn.execute(
                    text("SELECT signal_type, regime, sector, weight FROM signal_type_weights")
                ).fetchall()
                for row in rows:
                    self._signal_type_weights[(row[0], row[1], row[2])] = float(row[3])
        except Exception:
            pass  # fall back to 1.0 for all

    def _get_signal_weight(self, signal_type: str, regime: str, sector: str) -> float:
        """Return weight for (signal_type, regime, sector); fall back to (type, regime, ALL)."""
        w = self._signal_type_weights.get((signal_type, regime, sector))
        if w is not None:
            return w
        return self._signal_type_weights.get((signal_type, regime, 'ALL'), 1.0)

    def _load_rl_policy(self):
        """Load current RL policy from rl_q_table; store epsilon."""
        self._rl_epsilon: float = float('0.05')
        self._rl_q_cache: dict[tuple, str] = {}
        try:
            with self.engine.connect() as conn:
                # Load epsilon
                row = conn.execute(
                    text("SELECT value FROM app_settings WHERE key='rl_epsilon'")
                ).fetchone()
                if row:
                    self._rl_epsilon = float(row[0])

                # Load best action per state (argmax Q)
                rows = conn.execute(text("""
                    SELECT state_key, action, q_value FROM rl_q_table
                """)).fetchall()
                # Group by state_key, pick action with highest q_value
                state_q: dict[str, dict[str, float]] = {}
                for state_key, action, q_value in rows:
                    state_q.setdefault(state_key, {})[action] = float(q_value)
                for state_key, actions in state_q.items():
                    best = max(actions, key=lambda a: actions[a])
                    self._rl_q_cache[state_key] = best
        except Exception:
            pass

    def _get_rl_action(self, regime: str, sector: str, signal_score: int) -> str:
        """Look up current best RL action for given state. Returns 'BALANCED' as default."""
        import sys, os
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from rl_agent import get_state_key
            state_key = get_state_key(regime, sector, signal_score)
            return self._rl_q_cache.get(state_key, 'BALANCED')
        except Exception:
            return 'BALANCED'
```

- [ ] **Step 2: Call the new loaders in `__init__`**

In `__init__` (around line 56-60), after `self._load_optimised_weights()`, add:

```python
        self._load_signal_type_weights()
        self._load_rl_policy()
```

- [ ] **Step 3: Add `apply_signal_multipliers` helper**

After `_get_rl_action`, add:

```python
    def apply_signal_multipliers(
        self,
        raw_score: float,
        signal_types: list[str],
        regime: str,
        sector: str,
        signal_score: int,
    ) -> float:
        """Apply reward weights + RL action multipliers to a raw screener signal score."""
        import sys, os
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from rl_agent import get_multipliers
            action      = self._get_rl_action(regime, sector, signal_score)
            rl_mults    = get_multipliers(action)
        except Exception:
            rl_mults = {}

        adjusted = raw_score
        for st in signal_types:
            stw  = self._get_signal_weight(st, regime, sector)
            rlm  = rl_mults.get(st, 1.0)
            adjusted *= (stw * rlm)

        return adjusted
```

- [ ] **Step 4: Gate `recommendation_log` writes by win_probability**

In the `_log_recommendations` method (search for `recommendation_log` INSERT), find the condition where recs are logged and add a win_probability check. The existing code logs `Strong Buy` and `Buy`. Add `win_probability >= 0.45` guard:

Search for the INSERT into `recommendation_log` and wrap it:

```python
            # Only log if win_probability is acceptable (skip low-confidence signals)
            win_prob = float(stock_data.get('win_probability') or 0)
            if rec_type in ('BUY', 'STRONG_BUY') and win_prob > 0 and win_prob < 0.45:
                continue
```

- [ ] **Step 5: Verify scoring_engine starts without import errors**

```bash
cd c:/Github/bharat-stock-intelligence
python -c "from src.server.scoring_engine import AlphaQuantScoringEngine; print('OK')"
```
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/server/scoring_engine.py
git commit -m "feat(ml): scoring_engine loads signal_type_weights + RL policy at startup"
```

---

## Task 7: `technicalSignalsService.ts` — win_probability Gate

**Files:**
- Modify: `src/server/technicalSignalsService.ts:1025-1032`

- [ ] **Step 1: Update `getTechnicalSignalsForDate`**

In [technicalSignalsService.ts:1025-1032](src/server/technicalSignalsService.ts#L1025-L1032), change the function to:

```typescript
export function getTechnicalSignalsForDate(
  date?: string,
  minScore = 1,
  limit = 100
): Record<string, unknown>[] {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT ts.*, ns.name, ns.sector
    FROM technical_signals ts
    LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
    WHERE ts.date = ? AND ts.signal_score >= ?
      AND (ts.win_probability IS NULL OR ts.win_probability >= 0.40)
    ORDER BY ts.signal_score DESC
    LIMIT ?
  `).all(d, minScore, limit) as Record<string, unknown>[];
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Verify the server still starts**

```bash
npm run dev
```
Expected: server starts without errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat(ml): gate getTechnicalSignalsForDate by win_probability >= 0.40"
```

---

## Task 8: `queues.ts` — Two New BullMQ Jobs

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 1: Add queue name constants**

After the existing queue name constants (after line 63 in queues.ts), add:

```typescript
export const QUEUE_DAILY_LEARNING   = 'daily-learning-loop';
export const QUEUE_WEEKLY_BACKTEST  = 'weekly-backtest-optimizer';
```

- [ ] **Step 2: Add queue/worker module-level handles**

After `trendlyneIntradayQueue` declaration, add:

```typescript
export let dailyLearningQueue:   Queue | null = null;
export let weeklyBacktestQueue:  Queue | null = null;
let dailyLearningWorker:   Worker | null = null;
let weeklyBacktestWorker:  Worker | null = null;
```

- [ ] **Step 3: Add worker processor functions**

Add these two processor functions after `processQuantScoring` (after line ~168):

```typescript
import { execFile } from 'child_process';
import path from 'path';

const PYTHON_SCRIPTS_DIR = path.join(process.cwd(), 'src', 'server');

function runPythonScript(script: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      [path.join(PYTHON_SCRIPTS_DIR, script), ...args],
      { timeout: 10 * 60 * 1000 }, // 10 min per script
      (err, stdout, stderr) => {
        if (stdout) console.log(`[QUEUE][${script}]`, stdout.slice(0, 500));
        if (stderr) console.warn(`[QUEUE][${script}] stderr:`, stderr.slice(0, 200));
        if (err) { reject(err); return; }
        resolve();
      },
    );
  });
}

async function processDailyLearningLoop(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting daily learning loop...');
  const scripts: [string, string[]][] = [
    ['outcome_resolver.py',   ['--horizon', '15']],
    ['performance_tracker.py', ['--horizon', '15']],
    ['reward_engine.py',       []],
    ['rl_agent.py',            ['--update']],
    ['online_learner.py',      ['--window', '180']],
  ];
  for (const [script, args] of scripts) {
    console.log(`[QUEUE] Running ${script}...`);
    await runPythonScript(script, args);
  }
  return { success: true };
}

async function processWeeklyBacktestOptimizer(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Starting weekly backtest optimizer...');
  await runPythonScript('backtest_optimizer.py', ['--window', '365']);
  await runPythonScript('ml_ensemble.py', ['--train']);
  return { success: true };
}
```

- [ ] **Step 4: Register queues + workers inside `initQueues()`**

Find the last queue/worker registration inside `initQueues()` (the `trendlyneIntraday` block) and after it add:

```typescript
    // ── Daily learning loop (weekdays 16:30 IST = 11:00 UTC) ────────────────
    dailyLearningQueue = new Queue(QUEUE_DAILY_LEARNING, { connection });
    const dlRepeatables = await dailyLearningQueue.getRepeatableJobs();
    for (const r of dlRepeatables) await dailyLearningQueue.removeRepeatableByKey(r.key);
    await dailyLearningQueue.add(
      'daily-learn',
      {},
      {
        repeat: { pattern: '0 11 * * 1-5' }, // 11:00 UTC Mon–Fri
        jobId: 'daily-learn-repeatable',
        removeOnComplete: 5,
        removeOnFail: 3,
      },
    );
    dailyLearningWorker = new Worker(
      QUEUE_DAILY_LEARNING,
      processDailyLearningLoop,
      { connection, concurrency: 1, lockDuration: 30 * 60 * 1000 },
    );
    dailyLearningWorker.on('completed', () => console.log('[QUEUE] daily-learning-loop done'));
    dailyLearningWorker.on('failed', (_job, err) =>
      console.error('[QUEUE] daily-learning-loop failed:', err.message));

    // ── Weekly backtest optimizer (Sunday 20:30 UTC = Mon 02:00 IST) ────────
    weeklyBacktestQueue = new Queue(QUEUE_WEEKLY_BACKTEST, { connection });
    const wbRepeatables = await weeklyBacktestQueue.getRepeatableJobs();
    for (const r of wbRepeatables) await weeklyBacktestQueue.removeRepeatableByKey(r.key);
    await weeklyBacktestQueue.add(
      'weekly-backtest',
      {},
      {
        repeat: { pattern: '30 20 * * 0' }, // 20:30 UTC Sunday
        jobId: 'weekly-backtest-repeatable',
        removeOnComplete: 3,
        removeOnFail: 2,
      },
    );
    weeklyBacktestWorker = new Worker(
      QUEUE_WEEKLY_BACKTEST,
      processWeeklyBacktestOptimizer,
      { connection, concurrency: 1, lockDuration: 60 * 60 * 1000 },
    );
    weeklyBacktestWorker.on('completed', () => console.log('[QUEUE] weekly-backtest-optimizer done'));
    weeklyBacktestWorker.on('failed', (_job, err) =>
      console.error('[QUEUE] weekly-backtest-optimizer failed:', err.message));
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Verify server starts**

```bash
npm run dev
```
Expected: `[QUEUE] daily-learning-loop` and `[QUEUE] weekly-backtest-optimizer` appear in BullMQ init log.

- [ ] **Step 7: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat(queue): add daily-learning-loop and weekly-backtest-optimizer BullMQ jobs"
```

---

## Task 9: `router.ts` — 4 New tRPC Endpoints

**Files:**
- Modify: `src/server/router.ts` (append to the ML Feedback Framework section, after `optimizeScreenerWeights`)

- [ ] **Step 1: Add 4 new procedures**

Find the `optimizeScreenerWeights` procedure (last procedure in the ML Feedback section) and after its closing `}),` add:

```typescript
  getSignalTypeWeights: publicProcedure
    .input(z.object({
      regime:     z.string().optional(),
      signalType: z.string().optional(),
    }).optional())
    .query(({ input }) => {
      let query = `SELECT signal_type, regime, sector, weight, sample_count, last_updated
                   FROM signal_type_weights`;
      const params: string[] = [];
      const conditions: string[] = [];
      if (input?.regime) {
        conditions.push('regime = ?');
        params.push(input.regime);
      }
      if (input?.signalType) {
        conditions.push('signal_type = ?');
        params.push(input.signalType);
      }
      if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`;
      query += ' ORDER BY signal_type, regime, sector';
      return db.prepare(query).all(...params);
    }),

  getRLPolicy: publicProcedure.query(() => {
    const rows = db.prepare(`
      SELECT state_key, action, q_value, visit_count, last_updated
      FROM rl_q_table
      ORDER BY state_key, q_value DESC
    `).all() as { state_key: string; action: string; q_value: number; visit_count: number; last_updated: string }[];

    // Group by state_key, return best action per state
    const policy: Record<string, { action: string; q_value: number; visit_count: number }> = {};
    for (const row of rows) {
      if (!policy[row.state_key]) {
        policy[row.state_key] = {
          action:      row.action,
          q_value:     row.q_value,
          visit_count: row.visit_count,
        };
      }
    }

    const epsilon = (db.prepare(
      `SELECT value FROM app_settings WHERE key='rl_epsilon'`
    ).get() as { value: string } | undefined)?.value ?? '0.30';

    return { policy, epsilon: parseFloat(epsilon), total_states: Object.keys(policy).length };
  }),

  getRLEpisodeHistory: publicProcedure
    .input(z.object({ days: z.number().min(1).max(90).default(30) }).optional())
    .query(({ input }) => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (input?.days ?? 30));
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      return db.prepare(`
        SELECT id, date, state_key, action_taken, reward, epsilon
        FROM rl_episodes
        WHERE date >= ?
        ORDER BY id DESC
        LIMIT 500
      `).all(cutoffStr);
    }),

  getBacktestOptimization: publicProcedure.query(() => {
    const keys = [
      'optimal_min_score', 'optimal_horizon_days',
      'optimal_stop_loss_pct', 'optimal_sharpe',
      'optimal_category_weights', 'optimal_source_weights',
    ];
    const rows = db.prepare(`
      SELECT key, value, updatedAt FROM app_settings
      WHERE key IN (${keys.map(() => '?').join(',')})
    `).all(...keys) as { key: string; value: string; updatedAt: string }[];

    const result: Record<string, string | number | null> = {};
    for (const row of rows) {
      const num = parseFloat(row.value);
      result[row.key] = isNaN(num) ? row.value : num;
    }
    return { params: result };
  }),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Test endpoints in dev server**

```bash
npm run dev
```
Then in another terminal:
```bash
curl -s "http://localhost:3000/api/trpc/getRLPolicy" | python -m json.tool | head -20
curl -s "http://localhost:3000/api/trpc/getBacktestOptimization" | python -m json.tool
```
Expected: valid JSON responses (policy will be empty initially, backtest params show whatever is in app_settings).

- [ ] **Step 4: Commit**

```bash
git add src/server/router.ts
git commit -m "feat(api): add getSignalTypeWeights, getRLPolicy, getRLEpisodeHistory, getBacktestOptimization endpoints"
```

---

## Task 10: Full Integration Smoke-Test

**Goal:** Verify the complete daily learning loop runs end-to-end.

- [ ] **Step 1: Run all Python tests**

```bash
cd c:/Github/bharat-stock-intelligence/src/server
python -m pytest tests/ -v
```
Expected: all tests pass.

- [ ] **Step 2: Run complete daily loop manually (dry-run)**

```bash
cd c:/Github/bharat-stock-intelligence
python src/server/outcome_resolver.py --dry-run --horizon 15
python src/server/reward_engine.py --dry-run
python src/server/rl_agent.py --update --dry-run
python src/server/online_learner.py --dry-run
```
Expected: each script runs and exits without errors. May print "no data yet" if DB is fresh.

- [ ] **Step 3: Inspect RL policy state**

```bash
python src/server/rl_agent.py --inspect
```
Expected: 54-row grid with all Q-values = 0.0 and AGGRESSIVE as default (first alphabetically). This is correct — the agent starts neutral and learns over time.

- [ ] **Step 4: Verify scoring_engine loads new weights cleanly**

```bash
cd c:/Github/bharat-stock-intelligence
python -c "
import sys; sys.path.insert(0,'src/server')
from scoring_engine import AlphaQuantScoringEngine
e = AlphaQuantScoringEngine()
print('signal_type_weights loaded:', len(e._signal_type_weights))
print('rl_q_cache loaded:', len(e._rl_q_cache))
print('rl_epsilon:', e._rl_epsilon)
"
```
Expected: prints without errors. Counts will be 0 initially (no weights computed yet).

- [ ] **Step 5: Final commit**

```bash
git add .
git commit -m "feat(ml): complete reward/penalty + RL meta-controller integration"
```

---

## Verification Checklist

- [ ] All 4 Python test files pass (`pytest tests/ -v`)
- [ ] `npx tsc --noEmit` returns no errors
- [ ] `npm run dev` starts without errors
- [ ] `signal_type_weights`, `rl_q_table`, `rl_episodes` tables exist in DB
- [ ] `getTechnicalSignalsForDate` filters out win_probability < 0.40
- [ ] `daily-learning-loop` and `weekly-backtest-optimizer` appear in BullMQ queue list
- [ ] `getRLPolicy` and `getSignalTypeWeights` tRPC endpoints return valid JSON
