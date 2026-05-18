# Reward/Penalty Loop, Backtesting Optimization, Supervised & Reinforcement Learning

**Date:** 2026-05-18
**Status:** Approved

## Overview

Closes all open feedback loops in the existing ML pipeline and adds a tabular Q-learning
regime-aware meta-controller. Four components work together:

1. **Reward/Penalty Loop** — EMA-smoothed reward propagation per (signal_type, regime, sector)
2. **Backtest Optimizer** — Grid search finds optimal (min_score, horizon, SL%) weekly
3. **Supervised Learning Completion** — Auto-labeling, win_probability gate, feature pruning
4. **RL Meta-Controller** — Q-learning agent that selects signal amplification strategy per regime

---

## Architecture

```
DAILY OPS (BullMQ, 16:30 IST weekdays):
  outcome_resolver.py       → auto-labels signal_outcomes from OHLCV
  performance_tracker.py    → segment metrics (existing)
  reward_engine.py          → EMA reward/penalty → signal_type_weights
  rl_agent.py --update      → Q-learning update → rl_q_table
  online_learner.py         → SGD partial_fit (existing)

WEEKLY OPS (BullMQ, Sunday 02:00 IST):
  backtest_optimizer.py     → grid search → app_settings optimal params
  ml_ensemble.py --train    → full ensemble retrain (existing)

SIGNAL GENERATION (real-time, scoring_engine.py):
  1. Load optimal_category_weights   (strategy_optimizer — existing)
  2. Load signal_type_weights        (reward_engine — new)
  3. Load rl_policy for current state (rl_agent — new)
  4. Apply meta-action multipliers to signal scores
  5. Gate signals: filter win_probability < 0.40
```

---

## Section 1: Reward/Penalty Loop

### File: `src/server/reward_engine.py` (new)

Computes risk-adjusted rewards from resolved `signal_outcomes` and maintains
EMA-smoothed weight multipliers per (signal_type, regime, sector) in `signal_type_weights`.

**Reward formula:**
```
WIN:       reward = (return_pct / horizon_days) × 10
LOSS:      reward = (return_pct / horizon_days) × 10 × 1.5   # loss aversion
NEUTRAL:   reward = -0.05                                      # opportunity cost
STOP_LOSS: reward = (return_pct / horizon_days) × 10 × 2.0   # heaviest penalty
```

**EMA update** (α = 0.15):
```
new_weight = old_weight × (1 - 0.15) + reward × 0.15
weight clamped to [0.3, 2.0]
```

**New DB table:**
```sql
CREATE TABLE signal_type_weights (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_type  TEXT NOT NULL,
    regime       TEXT NOT NULL,
    sector       TEXT NOT NULL DEFAULT 'ALL',
    weight       REAL NOT NULL DEFAULT 1.0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL,
    UNIQUE(signal_type, regime, sector)
);
```

**`scoring_engine.py` change:**
Load `signal_type_weights` at startup. For each signal in the scoring run, multiply
its raw score by `weight` for the matching (signal_type, regime, sector) key before
category aggregation. Falls back to 1.0 if no row exists for that key.

---

## Section 2: Backtesting → Parameter Optimization

### File: `src/server/backtest_optimizer.py` (new)

Runs grid search over 300 parameter combinations using the existing `Backtester` class,
finds the config maximizing Sharpe ratio subject to constraints, writes to `app_settings`.

**Parameter grid:**
```
min_score:     [3, 4, 5, 6, 7]
horizon_days:  [7, 10, 15, 20, 30]
stop_loss_pct: [5, 7, 10, 12]
max_positions: [10, 15, 20]
```

**Constraints (result must satisfy all):**
- `win_rate >= 0.45`
- `max_drawdown_pct >= -25.0`
- `total_trades >= 20`

**Optimization target:** Sharpe ratio (primary)

**Update guard:** Only writes to `app_settings` if new Sharpe ≥ current Sharpe × 1.05.
Prevents thrashing from noise.

**Keys written to `app_settings`:**
```
optimal_min_score       → used as BUY signal threshold in scoring_engine
optimal_horizon_days    → passed to signal generation
optimal_stop_loss_pct   → used in SL calculation
```

**Rolling window:** Most recent 365 days of signals/OHLCV data only.

---

## Section 3: Supervised Learning — Closing the Open Loops

### 3a. Auto-labeling: `src/server/outcome_resolver.py` (new)

Runs daily. For each row in `technical_signals` where:
- `scan_date + horizon_days <= today`
- No matching row in `signal_outcomes`

Looks up close price from `stock_ohlcv` at `scan_date + horizon_days`, computes
`return_pct`, checks intraday low against `stop_loss` for STOP_LOSS detection,
writes outcome to `signal_outcomes`.

### 3b. win_probability gate

Two integration points for the `win_probability` field already set by `online_learner.py`:

**`src/server/technicalScanner.ts`:** When returning signals to frontend, add WHERE clause:
```sql
WHERE win_probability IS NULL OR win_probability >= 0.40
```
Threshold stored in `app_settings` key `min_win_probability` (default 0.40).

**`src/server/scoring_engine.py`:** Only log to `recommendation_log` when
`win_probability >= 0.45`.

### 3c. Feature importance feedback

After each `ml_ensemble.py --train`, features already written to `feature_importance_log`.
New logic in `reward_engine.py` (weekly pass): for any signal type whose one-hot feature
has ranked in the bottom third of importance for 4 consecutive weeks, nudge its default
weight in `signal_type_weights` down by 10% (floor 0.3).

---

## Section 4: RL Meta-Controller

### File: `src/server/rl_agent.py` (new)

Tabular Q-learning agent. 54 discrete states. 4 actions per state.

**State space:**
```
nifty_regime:   BULL | SIDEWAYS | BEAR               → 3 values
sector_bucket:  IT | BANK | PHARMA | AUTO | ENERGY | OTHER  → 6 values
score_bucket:   LOW(3-5) | MED(6-7) | HIGH(8-10)     → 3 values
Total states:   3 × 6 × 3 = 54
state_key:      "{regime}_{sector}_{score_bucket}"  e.g. "BULL_IT_HIGH"
```

**Action space:**
```
AGGRESSIVE:      RSI_DIVERGENCE, RESISTANCE_BREAKOUT, WEEK_52_BREAKOUT,
                 MACD_CROSSOVER, EMA_BULL_STACK multiplied ×1.5;
                 OVERSOLD_RECOVERY, BB_COMPRESSION ×0.7
CONSERVATIVE:    all signal type multipliers ×0.8;
                 win_probability gate raised to 0.55 for this scoring run
BALANCED:        all multipliers 1.0 (no change — baseline)
SECTOR_FOCUSED:  signals matching current sector ×1.4;
                 cross-sector signals ×0.8
```

**Reward:** `trade_return_pct - nifty_return_pct` (alpha), averaged over all trades
closed today that were initiated in the given state.

**Q-learning hyperparameters:**
```
α (learning rate):  0.10
γ (discount):       0.85
ε (exploration):    starts 0.30, decays to 0.05 over 90 days
ε decay:            ε × 0.985 per daily update
```

**Q-update:**
```
Q(s,a) ← Q(s,a) + α × [reward + γ × max_a' Q(s',a') − Q(s,a)]
```

**New DB tables:**
```sql
CREATE TABLE rl_q_table (
    state_key    TEXT NOT NULL,
    action       TEXT NOT NULL,
    q_value      REAL NOT NULL DEFAULT 0.0,
    visit_count  INTEGER NOT NULL DEFAULT 0,
    last_updated TEXT NOT NULL,
    PRIMARY KEY (state_key, action)
);

CREATE TABLE rl_episodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    state_key    TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    reward       REAL,
    epsilon      REAL,
    notes        TEXT
);
```

**`scoring_engine.py` integration:**
```python
state    = rl_agent.get_state(nifty_regime, sector, signal_score)
action   = rl_agent.get_policy(state)          # ε-greedy
mults    = rl_agent.get_multipliers(action)    # dict: signal_type → float
# multiply raw signal scores by mults before category aggregation
rl_agent.log_episode(state, action, epsilon)   # reward filled later by reward_engine
```

**`rl_agent.py --update`** (daily, post-close):
1. Fetch today's `rl_episodes` rows (reward is NULL)
2. Join to `signal_outcomes` for trades initiated on today's episode date
3. Compute alpha reward per state
4. Run Q-learning update for each (state, action, reward, next_state)
5. Persist updated Q-values to `rl_q_table`

---

## Section 5: Integration — DB, Endpoints, Queues

### New DB tables (3 total, added to `src/server/db.ts`):
- `signal_type_weights`
- `rl_q_table`
- `rl_episodes`

### New tRPC endpoints (`src/server/router.ts`):
```
getSignalTypeWeights      → all rows from signal_type_weights (for dashboard)
getRLPolicy               → current best action per state from rl_q_table
getRLEpisodeHistory       → recent rl_episodes with rewards for monitoring
getBacktestOptimization   → reads optimal_* keys from app_settings
```

### BullMQ jobs (`src/server/queues.ts`):
```
daily-learning-loop     cron: "30 11 * * 1-5"  (16:30 IST = 11:00 UTC Mon–Fri)
  Steps (sequential, each via child_process.execFile):
    1. outcome_resolver.py
    2. performance_tracker.py --horizon 15
    3. reward_engine.py
    4. rl_agent.py --update
    5. online_learner.py --window 180

weekly-backtest-optimizer  cron: "30 20 * * 0"  (Sunday 02:00 IST = 20:30 UTC Sat)
  Steps:
    1. backtest_optimizer.py --window 365
    2. ml_ensemble.py --train
```

---

## Files Changed / Created

### New files:
```
src/server/outcome_resolver.py
src/server/reward_engine.py
src/server/rl_agent.py
src/server/backtest_optimizer.py
```

### Modified files:
```
src/server/db.ts                  ← 3 new tables
src/server/scoring_engine.py      ← reads signal_type_weights + rl_policy at startup
src/server/technicalScanner.ts    ← win_probability gate on signal query
src/server/queues.ts              ← 2 new BullMQ jobs
src/server/router.ts              ← 4 new tRPC endpoints
```

---

## Error Handling & Safeguards

- All Python scripts exit cleanly with non-zero code on DB connection failure; BullMQ marks the job failed and retries up to 3 times.
- `reward_engine.py` skips symbols with fewer than 3 resolved outcomes (insufficient sample).
- `backtest_optimizer.py` only updates `app_settings` if new Sharpe ≥ current × 1.05.
- RL agent initializes all Q-values to 0.0; BALANCED action is always available as safe default.
- `win_probability` gate falls back to showing all signals if `technical_signals.win_probability` column is all NULL (no model trained yet).
- All new DB tables are created with `IF NOT EXISTS` so existing installs are not broken.

---

## Testing Approach

- `outcome_resolver.py --dry-run`: prints resolved outcomes without writing to DB
- `reward_engine.py --dry-run`: prints weight updates without committing
- `rl_agent.py --inspect`: prints current Q-table and policy per state
- `backtest_optimizer.py --dry-run`: runs grid search, prints best config, skips app_settings write
- tRPC endpoints testable via `/api/trpc/getSignalTypeWeights` in dev
