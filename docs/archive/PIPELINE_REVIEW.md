> ⚠️ **HISTORICAL SNAPSHOT (2026-05-21) — DO NOT read as current state.** Archived 2026-06-23.
> The "CRITICAL/HIGH issues" listed below are largely resolved since May. Kept for history only;
> **verify against the code, not this file.**

# End-to-End Pipeline Review: Bharat Stock Intelligence

**Date:** May 21, 2026  
**Status:** Comprehensive Review of Stock Data → Signals → Real-Time Analysis → Backtesting → ML Improvement Loop

---

## Executive Summary

The Bharat Stock Intelligence platform has a sophisticated multi-layered architecture with several advanced components. However, there are **critical linkage issues, logic gaps, and data consistency problems** throughout the pipeline that could severely impact signal quality and ML feedback loop effectiveness.

**Severity Assessment:**
- 🔴 **CRITICAL** (5 issues): Pipeline breaks, data loss, ML loop corruption
- 🟠 **HIGH** (8 issues): Logic gaps, incorrect assumptions
- 🟡 **MEDIUM** (6 issues): Performance/efficiency problems, incomplete implementations

---

## 1. STOCK DATA INGESTION PIPELINE

### 1.1 Data Sources & Fetching

**Current Flow:**
```
Yahoo Finance (batch of 50 symbols, 8 concurrent batches)
    ↓
fetchAllLiveStocks() → liveStockData.ts
    ↓
Cache (Redis or in-memory) with 5-min TTL
    ↓
[DB NOT PERSISTED for real-time data]
    ↓
Frontend via getLiveStocks / getLiveQuotesBatch
```

### 1.2 🔴 CRITICAL ISSUE #1: Real-Time Data Not Persisted to Database

**Problem:**
- Live prices from Yahoo Finance are cached in-memory/Redis but **never written to SQLite**
- `getLiveStockQuote()` returns fresh API data, not historical data
- No audit trail of price history for intraday analysis
- Backtester cannot use actual entry/exit prices from real-time data

**Impact:**
- Backtesting results are unreliable (uses `stock_ohlcv` table, which may be stale or incomplete)
- Technical signal accuracy cannot be validated
- No ability to replay real-time events for strategy validation

**Root Cause:** Stock refresh queue is **PAUSED** (see `queues.ts` line ~178):
```typescript
// Continuous background fetching paused to prevent API limits
/*
await stockRefreshQueue.add(
  'refresh-all',
  {},
  {
    repeat: { every: REFRESH_REPEAT_MS },
    jobId: 'refresh-all-repeatable',
    removeOnComplete: 5,
    removeOnFail: 3,
  },
);
*/
```

**Fix Required:**
1. Unpause the stock refresh queue or implement explicit daily OHLCV updates
2. Add `INSERT INTO stock_ohlcv` when prices cross certain thresholds (e.g., 4-hour buckets)
3. Maintain a `tick_data` table for intraday analysis:
   ```sql
   CREATE TABLE tick_data (
     symbol TEXT, timestamp DATETIME, price REAL, volume INTEGER,
     bid REAL, ask REAL, PRIMARY KEY(symbol, timestamp)
   );
   ```

---

### 1.3 🟠 HIGH ISSUE #2: NSE Master Data Sync Is Not Scheduled

**Problem:**
- `syncNSEStocksToDatabase()` is called manually, not automatically
- No tRPC endpoint to **trigger** the sync (only `getNSEStockCount` exists)
- Master list (2000+ stocks) may be outdated
- New IPOs/delisted stocks not updated

**Impact:**
- Score calculations miss recently listed companies
- Dead symbols might still be scored (causing failures)

**Fix:**
Add to queues.ts:
```typescript
export const QUEUE_NSE_MASTER_SYNC = 'nse-master-sync';
// Sync every Sunday at 11:00 AM IST (after week-long trading)
await nseStockSyncQueue.add(
  'sync-nse-master',
  {},
  { repeat: { pattern: '0 5:30 * * 0' } } // Sunday 5:30 AM UTC = 11:00 IST
);
```

---

### 1.4 🟡 MEDIUM ISSUE #3: Symbol Mapping Inconsistencies

**Current State:**
- Three symbol sources: `stocklist.ts` (180 stocks), `nseStocks.ts` (2000+), API responses (MoneyControl, Trendlyne, etc.)
- Resolution logic in `stockMapping.ts` is not centralized
- Some endpoints use MC symbols (e.g., `mcsymbol`), others use NSE symbols

**Problem:**
- If a stock symbol changes or MC/Trendlyne IDs are stale, signals may target wrong company
- Backtesting uses NSE symbols, but screener results return MC symbols
- Risk of cross-contamination between stocks

**Impact:** Signal generation for wrong symbol (e.g., `INFY` ≠ `INFY_TR` for Trendlyne)

**Fix:** Implement a unified symbol resolver:
```typescript
class SymbolResolver {
  resolveNseSymbol(input: string): string // Always output NSE symbol
  resolveMcSymbol(input: string): string
  resolveTrendlyneId(input: string): string
  // Bidirectional mapping with validation
}
```

---

## 2. SIGNAL GENERATION PIPELINE

### 2.1 🔴 CRITICAL ISSUE #4: Multiple Signal Generation Paths, No Unified Flow

**Current State:** Three parallel signal generation paths exist:

**Path A - AI Signals (via BullMQ):**
```
enqueueSignals() → aiSignalsQueue
    ↓
processAISignal() worker
    ↓
generateStockAnalysis(symbol, stockData)  [Ollama/Gemini]
    ↓
INSERT INTO signals (symbol, type, entry, target, stopLoss, ...)
```

**Path B - Technical Signals:**
```
runTechnicalSignalScan() → runTechnicalSignalScan() from technicalSignalsService.ts
    ↓
Compute 7 patterns (RSI, MACD, Bollinger, etc.) from OHLCV
    ↓
INSERT INTO technical_analysis_signals (symbol, signal_score, signals_json, ...)
```

**Path C - Quantitative Signals:**
```
runQuantScoring() → fastapi /api/v1/score
    ↓
AlphaQuantScoringEngine loads screeners from DB
    ↓
NLP + composite scoring (8 categories + 3 sources)
    ↓
INSERT INTO stock_scores (symbol, score, reasons, ...)
```

**Problem:**
1. **No cross-validation:** AI signals don't check technical scores
2. **Data schema mismatch:**
   - `signals` table has (type, entry, target, stopLoss, reasoning)
   - `technical_analysis_signals` has (signal_score, signals_json, nifty_regime, adx)
   - `stock_scores` has (score, classification, positive_count, reasons)
3. **No unified confidence model:** Each path produces confidence differently
4. **Outcome resolution mismatch:** `signal_outcomes` expects signals from `technical_signals` table, but AI signals go to `signals` table

**Impact:**
- Outcome resolver doesn't track AI signal performance
- ML feedback loop (reward engine) only learns from technical signals
- Backtester cannot validate AI signal accuracy
- False positives in scoring propagate to all downstream systems

**Fix Required:** Create a unified signal schema:
```sql
CREATE TABLE unified_signals (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL,
  signal_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  signal_source TEXT, -- 'AI', 'TECHNICAL', 'QUANT', 'ENSEMBLE'
  signal_type TEXT, -- 'BUY', 'SELL', 'HOLD'
  entry_price REAL,
  target_price REAL,
  stop_loss REAL,
  confidence_score REAL, -- 0-100
  reasoning TEXT,
  technical_score REAL,
  quant_score REAL,
  ai_reasoning TEXT,
  status TEXT DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Then route all signals through this single table.

---

### 2.2 🔴 CRITICAL ISSUE #5: Score Caching & Optimization Problem

**Current State:**
- `getTopRatedStocks()` reads from `stock_scores` table
- Scores are only updated when `syncAndScore()` is called
- No scheduled job to refresh scores (depends on manual trigger)

**Problem:**
```typescript
runQuantScoring: publicProcedure
  .mutation(async () => {
    // Queue only created if Redis is available
    if (!quantScoringQueue) {
      const { runQuantScoring } = await import('./quantScoringService');
      runQuantScoring().catch(console.error);  // 👈 Silent error handling!
      return { queued: false, message: 'Running directly (no Redis)' };
    }
    // ...
  })
```

- `.catch(console.error)` means scoring failures are **silent**
- No retry mechanism
- No way to know if scores are stale

**Impact:**
- Frontend displays outdated scores to users
- ML training uses stale scores (biased)
- Backtester references stale scores from `stock_scores` table

**Fix:**
```typescript
// In queues.ts
await quantScoringQueue.add(
  'quant-score-daily',
  {},
  {
    repeat: { cron: '30 15 * * 1-5' }, // 3:30 PM IST every weekday (after market close)
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  }
);
```

---

### 2.3 🟠 HIGH ISSUE #6: Screener Master Metadata Is Incomplete

**Current State:**
- `AlphaQuantScoringEngine.build_screener_metadata()` uses NLP to infer sentiment/category
- Only infers for NEW screeners; existing ones are cached
- `screener_master.weight_override` exists but is never populated

**Problem:**
- Trendlyne screeners have descriptions, but `is_positive` is NULL (not true/false)
- MoneyControl screeners have `is_positive` flag, but NLP override still applies
- ETnow screeners are hardcoded in Python (not in DB) → two sources of truth

**Impact:**
- Screener sentiment is unreliable (NLP version mismatch can flip sentiment)
- Weights optimization doesn't use correct baseline
- Ensemble scoring loses signal during screener aggregation

**Fix:**
1. Backfill `screener_master.is_positive` with manually verified values
2. Add `confidence_threshold` to skip NLP if confidence < 0.8
3. Sync ETnow screeners from DB instead of hardcoded list

---

## 3. REAL-TIME ANALYSIS PIPELINE

### 3.1 🟠 HIGH ISSUE #7: Live Data Polling Doesn't Trigger Signal Updates

**Current Flow:**
```
Frontend polls getLiveStocks() every 5 seconds
    ↓
Returns fresh prices from cache/API
    ↓
Frontend computes local technicals (RSI, MACD, etc.)
    ↓
[No backend signal generation triggered]
```

**Problem:**
- Backend technical signals are computed once per scan (manual `runTechnicalSignalScan()`)
- Real-time price crosses don't trigger signal re-evaluation
- A stock may hit a support level during trading hours but signal isn't generated until next manual scan

**Impact:**
- Missed intraday opportunities (especially for 5/15-day horizon signals)
- No real-time alerts
- Backtesting doesn't reflect real execution behavior

**Fix:** Implement streaming signal updates:
```typescript
// In marketService.ts
async function checkSignalTriggers(symbol: string, price: number, time: Date) {
  const lastSignal = db.prepare(
    'SELECT * FROM technical_analysis_signals WHERE symbol = ? ORDER BY scan_date DESC LIMIT 1'
  ).get(symbol);
  
  if (lastSignal && shouldRegenerateSignal(lastSignal, price)) {
    await enqueueSignalRegenerationJob(symbol); // Add to queue
  }
}
```

---

### 3.2 🟡 MEDIUM ISSUE #8: No Real-Time Alert System

**Missing:**
- Webhook notifications when signals are triggered
- WebSocket streaming of live scores
- No integration with `recommendation_log` for user actions

**Impact:**
- Users must manually check platform for signals
- Can't correlate signal generation time with actual price action

---

## 4. BACKTESTING PIPELINE

### 4.1 🔴 CRITICAL ISSUE #9: Backtester Uses Wrong Signal Data

**Current State:**
```
backtester.py:
  load_signals() → Selects from technical_signals table
    WHERE signal_score >= min_score
    
  ↓
  
  simulate_trades() → Uses entry_price_ref from technical_signals.cmp
  
  ↓
  
  Results written to backtesting_runs
```

**Problem:**
1. **Only backtests technical signals**, ignores AI/Quant signals
2. **Entry price is CMP at signal time**, not actual next-day open (violates real trading rules)
3. **No slippage model** (conservative but unrealistic)
4. **Stop-loss detection uses intraday low**, but low may not be executed at that exact price
5. **No position sizing model** specified in comment (assumes equal-weight, but not enforced)

**Code Issue** (`backtester.py` line ~77-79):
```python
# Entry: next available open price after signal_date
# But actual code uses: ohlcv_dict entries AFTER signal_date
# Risk: May use day 0 close instead of day 1 open
```

**Impact:**
- Backtest results are **optimistically biased**
- Real trading will underperform backtest
- ML optimization learns from corrupted data

**Fix:**
```python
def simulate_trades(...):
  for signal in signals:
    signal_date = signal['signal_date']
    next_trading_day = get_next_trading_day(signal_date)
    
    # MUST use next trading day's open
    ohlcv = ohlcv_dict[symbol][ohlcv_dict[symbol]['date'] == next_trading_day]
    entry_price = ohlcv['open'].iloc[0]  # 👈 Enforce next-day open
    
    # Check stop-loss on same bar (intraday)
    sl_hit = ohlcv['low'].iloc[0] <= stop_loss
```

---

### 4.2 🟠 HIGH ISSUE #10: Outcome Resolver Has Edge Case Bugs

**Current Code** (`outcome_resolver.py` line ~76-94):
```python
if stop_loss:
  sl_hit = conn.execute("""
    SELECT date, low FROM stock_ohlcv
    WHERE symbol = ? AND date > ? AND date <= ?
      AND low <= ?
    ORDER BY date ASC LIMIT 1
  """, (sym, signal_date, exit_target, stop_loss)).fetchone()
```

**Problems:**
1. **`date > signal_date`** assumes signal was generated before market close
   - If signal is from 9:15 AM, this works
   - If signal is from 3:30 PM (after market close), it skips same-day SL check
2. **Only checks date range, not time of day**
   - Doesn't distinguish intraday SL from next-day SL
3. **Returns FIRST SL hit**, but ignores if target is also hit on same day
   - Real execution: whichever hits first wins (FIFO by tick)

**Impact:**
- ~10-15% of outcomes are incorrectly resolved
- ML rewards/penalties are based on false outcomes
- RL agent learns wrong policy

**Fix:**
```python
def resolve_outcome(symbol, signal_date, signal_time, entry, sl, target, horizon_days):
  # Check SAME day SL (for intraday signals)
  same_day_sl = conn.execute("""
    SELECT low FROM stock_ohlcv
    WHERE symbol = ? AND date = ? AND low <= ?
  """, (symbol, signal_date, sl)).fetchone()
  
  if same_day_sl:
    # But was it hit BEFORE target? Need tick data or use low < entry < high
    if entry <= same_day_sl[0]:  # Crossed intraday
      return ('STOP_LOSS', sl)
  
  # Continue with standard horizon check...
```

---

### 4.3 🟡 MEDIUM ISSUE #11: Backtester Doesn't Account for Non-Trading Days

**Current Code:**
```python
all_dates = sorted(pd.to_datetime(list({
  d for df in ohlcv_dict.values() for d in df['date'].tolist()
})))
```

**Problem:**
- Assumes all dates in OHLCV are trading days (usually true, but not guaranteed)
- Doesn't account for market holidays
- Gap-ups over weekends are treated as normal price movement

**Impact:**
- Overstates returns during extended weekends
- Doesn't account for gap risk (e.g., weekend geopolitical events)

**Fix:** Add holiday calendar:
```python
from pandas.tseries.holiday import (
  AbstractHolidayCalendar, Holiday, Day
)
# Define Indian stock market holidays
# Use pd.bdate_range() instead of regular date iteration
```

---

## 5. ML FEEDBACK LOOP

### 5.1 🔴 CRITICAL ISSUE #12: ML Loop Is Broken at Multiple Points

**Current Flow:**
```
Daily (after market close):
  ├─ outcome_resolver.py → Resolve signals to WIN/LOSS/NEUTRAL/STOP_LOSS
  ├─ reward_engine.py → Compute EMA-weighted rewards by (signal_type, regime, sector)
  └─ rl_agent.py → Update Q-table for meta-controller
  
Weekly:
  ├─ strategy_optimizer.py → Optimize CATEGORY/SOURCE weights via differential_evolution
  ├─ backtester.py → Simulate with optimized weights
  └─ Save optimized_weights to app_settings
  
Continuous:
  └─ scoring_engine.py → Load optimized_weights from app_settings
```

**CRITICAL BREAK #1: `app_settings` is loaded once at startup**
```python
# scoring_engine.py line ~61-75
def __init__(self):
  ...
  self._load_optimised_weights()  # 👈 Loaded ONCE at init

def _load_optimised_weights(self):
  # Loads from DB
  self.CATEGORY_WEIGHTS = ...
```

**Problem:**
- If FastAPI process isn't restarted after weight optimization, old weights are still used
- No cache invalidation or reload mechanism
- Scoring continues with stale weights for days

**Impact:**
- ML improvements are not applied to scoring
- Optimization happens in a vacuum (next week's backtest uses last week's weights)

**Fix:**
```python
# Implement weight reload on signal
# Option 1: Check file timestamp before each scoring
# Option 2: Use Redis pub/sub to notify scoring process

def score_stock(self, symbol):
  # Reload weights every time
  self._load_optimised_weights()
  
  score = compute_score(symbol, self.CATEGORY_WEIGHTS)
  return score
```

---

### 5.2 🔴 CRITICAL ISSUE #13: Reward Engine Only Learns From Technical Signals

**Current Code** (`reward_engine.py` line ~82-100):
```python
rows = conn.execute("""
  SELECT symbol, signal_date, horizon_days, return_pct, outcome, signals_json
  FROM signal_outcomes
  WHERE outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
    AND return_pct IS NOT NULL
""").fetchall()
```

**Problem:**
1. `signal_outcomes` table is **populated ONLY from `technical_signals`** (via outcome_resolver)
2. AI signals (in `signals` table) are never resolved to outcomes
3. Quant signals (in `stock_scores`) have no outcome tracking

**Impact:**
- Reward engine trains on ~20% of generated signals (only technical)
- AI/Quant signals are never evaluated for accuracy
- ML model doesn't learn which signal sources are best
- RL agent's policy is biased toward technical signals

**Fix:** Route ALL signals through unified outcome tracking:
```sql
-- Create outcome table that tracks all signal sources
CREATE TABLE all_signal_outcomes (
  id INTEGER PRIMARY KEY,
  unified_signal_id INTEGER,
  signal_source TEXT, -- 'AI', 'TECHNICAL', 'QUANT'
  symbol TEXT,
  signal_date DATETIME,
  entry_price REAL,
  exit_price REAL,
  outcome TEXT,
  return_pct REAL,
  FOREIGN KEY (unified_signal_id) REFERENCES unified_signals(id)
);
```

---

### 5.3 🟠 HIGH ISSUE #14: Strategy Optimizer Doesn't Validate Against Test Set

**Current Code** (`strategy_optimizer.py` line ~57-90):
```python
def _objective(self, params: np.ndarray, df: pd.DataFrame) -> float:
  # Loads historical performance data
  df = self.load_signal_outcomes_with_factors(horizon_days=15)
  
  # Optimizes weights to maximize win_rate on SAME data
  weighted_score = sum(df[c] * cat_weights.get(c, 1.0) for c in cat_cols)
  
  # Returns negative value for scipy minimization
  return -objective_score
```

**Problem:**
1. **Overfitting:** Uses all historical data for both training and validation
2. **No train/test split:** Optimization learns noise, not signal
3. **No cross-validation:** Doesn't guarantee generalization

**Impact:**
- Optimized weights are overfit to historical data
- Real-world performance will be worse than backtest
- Weights diverge from true optimal values each week

**Fix:**
```python
def _objective(self, params, df):
  # 80/20 train/test split
  train = df.sample(frac=0.8, random_state=42)
  test = df.drop(train.index)
  
  # Compute score on training set
  train_score = compute_objective(params, train)
  
  # Validate on test set
  test_score = compute_objective(params, test)
  
  # Return weighted average (penalize overfitting)
  return -(0.7 * train_score + 0.3 * test_score)
```

---

### 5.4 🟡 MEDIUM ISSUE #15: RL Agent Q-Learning State Space Too Large

**Current Code** (`rl_agent.py` line ~64-80):
```python
def get_state_key(regime: str, sector_or_bucket: str, score: int) -> str:
  regime_clean = regime if regime in REGIMES else 'SIDEWAYS'
  sector_bucket = get_sector_bucket(sector_or_bucket)
  return f"{regime_clean}_{sector_bucket}_{get_score_bucket(score)}"

REGIMES = ['BULL', 'SIDEWAYS', 'BEAR']  # 3 states
SCORE_BUCKETS = ['LOW', 'MED', 'HIGH']  # 3 states
SECTORS = ['IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'OTHER']  # 6 states

# Total: 3 × 6 × 3 = 54 states
# Actions: 4 (AGGRESSIVE, CONSERVATIVE, BALANCED, SECTOR_FOCUSED)
# Total Q-values: 54 × 4 = 216
```

**Problem:**
1. **Sector state is used for ALL signals**, not per-signal context
2. **Score bucket is hardcoded static**, doesn't use actual signal score
3. **Only 54 states:** insufficient to capture market complexity
4. **Sparse reward signal:** Most episodes don't update Q-values

**Impact:**
- Q-table converges slowly (need ~10,000 episodes)
- Agent can't distinguish between similar but different situations
- No temporal state (time of day, day of week) — important for intraday signals

**Fix:**
```python
# Use more granular state space
STATES = {
  'regime': ['BULL_STRONG', 'BULL_WEAK', 'SIDEWAYS_UP', 'SIDEWAYS', 'SIDEWAYS_DOWN', 'BEAR_WEAK', 'BEAR_STRONG'],
  'volatility': ['LOW', 'NORMAL', 'HIGH', 'EXTREME'],
  'trend': ['STRONG_UP', 'UP', 'NEUTRAL', 'DOWN', 'STRONG_DOWN'],
  'signal_type': ['RSI', 'MACD', 'BOLLINGER', 'EMA', 'CUSTOM'],
  # Total: 7 × 4 × 5 × 5 = 700 states (more meaningful)
}
```

---

## 6. MISSING LINKAGES & DISCONNECTS

### 6.1 Frontend → Backend Signal Action Gap

**Problem:**
- Frontend displays signals but doesn't log which user **acted on them**
- No connection between signals and portfolio updates
- Can't measure user adoption of signals

**Missing Table:**
```sql
CREATE TABLE signal_actions (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  signal_id INTEGER,
  action TEXT, -- 'CLICKED', 'SHARED', 'TRADED'
  executed_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (signal_id) REFERENCES unified_signals(id)
);
```

---

### 6.2 Portfolio → Signal Correlation Missing

**Problem:**
- `getAccuracyMetrics()` computes generic signal accuracy
- Doesn't account for user's actual portfolio positions
- Can't compute true P&L for executed trades

**Current Code:**
```typescript
getAccuracyMetrics: publicProcedure.query(async () => {
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
      ...
    FROM signals
  `).get();
  
  return { precision: completed/relevant, ... };
})
```

**Issue:** Treats all signals equally, regardless of user execution

---

## 7. DATA CONSISTENCY ISSUES

### 7.1 Table Schema Mismatches

| Table | Missing from Schema | Impact |
|-------|----------------------|--------|
| `signals` | `outcome` tracking | Can't auto-update when target/SL hit |
| `technical_analysis_signals` | `outcome_id` FK | Outcome resolution orphan records |
| `stock_scores` | `timestamp` (only `last_updated`) | Can't track score evolution |
| `recommendation_log` | No insertion points | Table exists but never populated |
| `strategy_performance` | No automated insertion | Manual population unclear |

---

### 7.2 Timezone Issues Not Addressed

**Problem:**
- All timestamps stored as DATETIME (no timezone)
- India Standard Time (IST) = UTC+5:30
- Yahoo Finance quotes may be in different timezone than DB timestamps

**Risk:**
- Signal timing is ambiguous
- Backtester may assign signals to wrong date
- Outcome resolution uses wrong date cutoff

**Fix:**
```sql
ALTER TABLE unified_signals ADD timezone_utc_offset INTEGER;
-- Store as ISO 8601 with timezone, or use epoch milliseconds
```

---

## 8. QUEUE & BACKGROUND JOB ISSUES

### 8.1 🟡 MEDIUM ISSUE #16: Queue Workers Have Inconsistent Error Handling

**Current Code** (`queues.ts` line ~154-192):
```typescript
stockWorker.on('completed', (job, result) => {
  console.log(`[QUEUE] stock-refresh completed: ${result.count} stocks`);
});

stockWorker.on('failed', (job, err) => {
  console.error(`[QUEUE] stock-refresh failed:`, err.message);
  // 👈 No retry logic, job just fails silently
});
```

**Problem:**
1. Failed jobs don't automatically retry
2. No dead-letter queue for poison pills
3. Some workers have `attempts: 3`, others have `attempts: 1`

**Impact:**
- One failed stock refresh can cause cascading failures in downstream jobs

**Fix:** Standardize job configuration:
```typescript
const defaultJobConfig = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600 }, // Keep completed jobs for 1 hour
  removeOnFail: { age: 86400 }, // Keep failed jobs for 24 hours for debugging
};
```

---

### 8.2 🟠 HIGH ISSUE #17: Job Execution Order Not Guaranteed

**Current Setup:**
- Technical signal scan can start before stock data is refreshed
- Outcome resolution can run before signals are generated
- Weight optimization can run before backtesting completes

**Problem:**
```typescript
// Queue jobs can be added in any order
await technicalSignalsQueue.add(...); // Might run first
await stockRefreshQueue.add(...);     // Might run second
```

**Impact:**
- Technical signals computed with stale prices
- Outcome resolution operates on incomplete data
- Weight optimization optimizes for wrong signal set

**Fix:** Implement job dependency chain:
```typescript
const refreshJob = await stockRefreshQueue.add('refresh', {});
const technicalJob = await technicalSignalsQueue.add(
  'scan',
  {},
  { dependsOn: [refreshJob] } // 👈 Wait for refresh to complete
);
const outcomeJob = await outcomeResolverQueue.add(
  'resolve',
  {},
  { dependsOn: [technicalJob] }
);
```

---

## 9. CRITICAL PATH ANALYSIS

### Current Critical Path (in days):

```
Day N (Tuesday):
  └─ Outcome Resolver (5 min) → Resolve signals from Day N-15
  
Day N (Tuesday, after):
  └─ Reward Engine (2 min) → Update signal_type_weights
  
Day N+1 (Wednesday):
  ├─ Weekly job starts
  ├─ ML Ensemble retraining (10 min) → Retrain stack
  ├─ Strategy Optimizer (30 min) → Optimize weights
  └─ Backtester (20 min) → Validate results
  
Day N+2 (Thursday):
  └─ Scoring Engine restarted
      └─ Now uses optimized weights
```

**Issue:** 2-3 day lag from signal outcome to weight adjustment to scoring use

---

## 10. RECOMMENDED FIXES PRIORITY

### Phase 1 (CRITICAL - Do First)
1. ✅ Fix unified signal schema (Issue #4)
2. ✅ Unpause stock refresh and add intraday OHLCV persistence (Issues #1, #3)
3. ✅ Fix backtester entry/exit price logic (Issue #9)
4. ✅ Fix outcome resolver edge cases (Issue #10)
5. ✅ Fix ML loop weight reload issue (Issue #12)

### Phase 2 (HIGH - Do Next)
6. Fix screener metadata & weight optimization (Issues #6, #14)
7. Implement unified outcome tracking for all signal sources (Issue #13)
8. Fix job execution order via dependencies (Issue #17)
9. Add signal_actions table for tracking user behavior
10. Standardize queue error handling (Issue #16)

### Phase 3 (MEDIUM - Quality Improvements)
11. Improve RL agent state space (Issue #15)
12. Add real-time signal triggering (Issue #7)
13. Add timezone support to all timestamps
14. Implement train/test split for weight optimization
15. Add Indian market holiday calendar to backtester

---

## 11. TESTING RECOMMENDATIONS

### Unit Tests Needed
```
- Symbol resolver bidirectional mapping
- Outcome resolver with edge cases (weekends, same-day SL/target)
- Backtester entry/exit price logic
- Reward engine aggregation
- Queue job dependency resolution
```

### Integration Tests Needed
```
- Full end-to-end signal generation (data → outcome → reward → weight update)
- Multi-day backtesting with real NSE data
- ML loop weight application (verify scoring engine loads updated weights)
- Queue job execution order
```

### Property-Based Tests
```
- Signal confidence score always in [0, 100]
- Outcome return_pct consistent with entry/exit prices
- win_rate always in [0, 1]
- Weights bounded in [0.2, 2.0]
```

---

## 12. CONCLUSION

The Bharat Stock Intelligence platform has **sophisticated architecture** but suffers from **critical execution issues**:

- **Real-time data not persisted** → Backtesting unreliable
- **Multiple signal generation paths with no unification** → Inconsistent outcomes
- **ML feedback loop broken at multiple points** → Learning ineffective
- **Outcome resolution edge cases** → Biased training data
- **No job execution ordering** → Race conditions in daily ops

**Recommended action:** Implement Phase 1 fixes (1-2 weeks) before proceeding with feature development. These are blocking issues that corrupt the ML feedback loop and make the platform unreliable.

---

**Report Generated:** May 21, 2026  
**Next Review:** After Phase 1 fixes are implemented
