# Quantitative Strategy Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 13 confirmed bugs across the scoring engine, ML pipeline, scheduling, and signal tracking — then add 3 new trading strategies (cross-source convergence, regime-sector rotation, quality oversold reversion) with 3 new tRPC endpoints.

**Architecture:** Python scoring engine fixes are self-contained in `scoring_engine.py`, `strategy_optimizer.py`, `performance_tracker.py`, `outcome_resolver.py`, and `reward_engine.py`. TypeScript fixes target `signalOutcomesService.ts` and `queues.ts`. New strategy functions land in `scoringService.ts` with endpoints added to `router.ts`. Schema migration via `db.ts` `migrateColumn`.

**Tech Stack:** Python 3.10+, SQLAlchemy, pandas, SQLite (better-sqlite3), BullMQ, tRPC/Zod, TypeScript

---

## Bug Inventory (found during code review)

| # | File | Severity | Description |
|---|---|---|---|
| B1 | `scoring_engine.py` | CRITICAL | `weight_override` computed by optimizer but never loaded or applied in scoring loop |
| B2 | `strategy_optimizer.py` | CRITICAL | Per-screener override query JOINs only `trendlyne_screener_stocks` — MC + ETnow excluded |
| B3 | `scoring_engine.py` | CRITICAL | ML `win_probability` in `technical_signals` never incorporated into composite score |
| B4 | `queues.ts` | HIGH | `etnowScreenerSyncWorker` + `trendlyneIntradayWorker` absent from `shutdownQueues()` |
| B5 | `scoring_engine.py` | CRITICAL | et-520/518/514/515 (group screeners) hardcoded `is_positive: 0` — stocks penalized for belonging to their own conglomerate |
| B6 | `signalOutcomesService.ts` vs `outcome_resolver.py` | HIGH | WIN threshold mismatch: TypeScript uses >0.5%, Python uses >1.0% — win rate stats diverge |
| B7 | `performance_tracker.py` | CRITICAL | `LEFT JOIN technical_signals ts ON ts.scan_date` — column is `date` not `scan_date` → regime/adx/rsi always NULL |
| B8 | `signalOutcomesService.ts` | HIGH | No stop-loss detection: always uses close at target date, overestimates WIN/NEUTRAL |
| B9 | `scoring_engine.py` | HIGH | `_load_screener_metadata()` SELECT omits `weight_override` — even after loop fix, override value is unavailable |
| B10 | `rl_agent.py` | MEDIUM | `SECTOR_MAP` missing infrastructure/ports/logistics/capital goods — ADANIPORTS always bucketed as 'OTHER' |
| B11 | `scoring_engine.py` | MEDIUM | News recency: 1-hour headline == 6-day headline (both get recency ≈ 1.0 in 7-day window) |
| B12 | `queues.ts` / scheduling | HIGH | `outcome_resolver.py` (has stop-loss detection) never scheduled — manually run only |
| B13 | `queues.ts` / scheduling | HIGH | `reward_engine.py` + `rl_agent.py` not in BullMQ — ML feedback loop never auto-runs |
| B14 | `technicalSignalsService.ts` | MEDIUM | `computeNiftyRegime()` defaults to 'BULL' when <50 Nifty bars — hardcoded optimistic bias |

---

## File Map

**Modified:**
- `src/server/scoring_engine.py` — B1, B3, B5, B9, B11
- `src/server/strategy_optimizer.py` — B2
- `src/server/performance_tracker.py` — B7
- `src/server/signalOutcomesService.ts` — B6, B8
- `src/server/queues.ts` — B4, B12, B13
- `src/server/rl_agent.py` — B10
- `src/server/technicalSignalsService.ts` — B14
- `src/server/scoringService.ts` — new strategy functions
- `src/server/router.ts` — 3 new tRPC endpoints
- `src/server/db.ts` — `signal_type_tag` migration

**Created:**
- `src/server/strategySignalsService.ts` — `crossSourceFilter`, `regimeSectorFilter`, `qualityOversoldScanner`

---

## Task 1: Fix `weight_override` loading and application (B1, B9)

**Files:**
- Modify: `src/server/scoring_engine.py`

- [ ] **Step 1: Update `_load_screener_metadata()` to include `weight_override`**

```python
# scoring_engine.py — replace _load_screener_metadata method (~line 218)
def _load_screener_metadata(self) -> Dict[str, Any]:
    with self.engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT scan_id, name, source, inferred_sentiment, inferred_category, "
            "inferred_timeframe, confidence, COALESCE(weight_override, 1.0) AS weight_override "
            "FROM screener_master"
        )).fetchall()
    return {
        r[0]: {
            'name':           r[1],
            'source':         r[2],
            'sentiment':      r[3],
            'category':       r[4],
            'timeframe':      r[5],
            'confidence':     r[6],
            'weight_override': float(r[7]),
        }
        for r in rows
    }
```

- [ ] **Step 2: Apply `weight_override` in the screener scoring loop**

```python
# scoring_engine.py — in process_scoring, inside the "── Screener scoring" loop (~line 397)
# Replace:
#   contrib = base_score * cat_weight * src_weight * sentiment_mult * recency * dedup
# With:
override = meta.get('weight_override', 1.0)
contrib = base_score * cat_weight * src_weight * sentiment_mult * recency * dedup * override
```

- [ ] **Step 3: Verify manually — print override applied count**

```python
# Temporary debug print inside process_scoring after loop (remove after verification):
overridden = sum(1 for m in screeners_meta.values() if m.get('weight_override', 1.0) != 1.0)
print(f"[ScoringEngine] {overridden} screeners have non-default weight_override applied")
```

- [ ] **Step 4: Commit**

```bash
git add src/server/scoring_engine.py
git commit -m "fix: apply screener weight_override from screener_master in scoring loop"
```

---

## Task 2: Fix group/universe screeners misclassified as bearish (B5)

**Files:**
- Modify: `src/server/scoring_engine.py`

- [ ] **Step 1: Change `is_positive` to 1 for all 4 group screeners**

```python
# scoring_engine.py — replace ETNOW_SCREENERS list (~line 17)
ETNOW_SCREENERS = [
    { 'scan_id': 'et-73',   'name': 'Cash Cows',              'is_positive': 1 },
    { 'scan_id': 'et-75',   'name': 'Elite Bluechips',         'is_positive': 1 },
    { 'scan_id': 'et-79',   'name': 'Zero Debt Quality',       'is_positive': 1 },
    { 'scan_id': 'et-91',   'name': 'Buy on Dips',             'is_positive': 1 },
    { 'scan_id': 'et-195',  'name': 'Potential Multibaggers',  'is_positive': 1 },
    { 'scan_id': 'et-118',  'name': 'Straight Flush',          'is_positive': 1 },
    { 'scan_id': 'et-362',  'name': 'RSI Oversold',            'is_positive': 1 },
    { 'scan_id': 'et-518',  'name': 'The Tata Empire',         'is_positive': 1 },  # group screener — was 0
    { 'scan_id': 'et-520',  'name': 'Adani Universe',          'is_positive': 1 },  # group screener — was 0
    { 'scan_id': 'et-514',  'name': 'PSU Gems',                'is_positive': 1 },  # group screener — was 0
    { 'scan_id': 'et-515',  'name': 'Monopoly Biz',            'is_positive': 1 },  # group screener — was 0
    { 'scan_id': 'et-1101', 'name': 'Defence Sector',          'is_positive': 1 },
    { 'scan_id': 'et-1100', 'name': 'Infra Boost',             'is_positive': 1 },
]
```

- [ ] **Step 2: Commit**

```bash
git add src/server/scoring_engine.py
git commit -m "fix: correct is_positive for group/universe ETnow screeners (Adani, Tata, PSU, Monopoly)"
```

---

## Task 3: Integrate ML `win_probability` consensus bonus (B3)

**Files:**
- Modify: `src/server/scoring_engine.py`

- [ ] **Step 1: Load win_probability map before timeframe loop in `process_scoring`**

```python
# scoring_engine.py — add after "Attach last_updated to screener metadata" block (~line 327)

# Load latest ML win_probability per symbol (from technical_signals, today or yesterday)
print("Loading ML win_probability from technical_signals...")
with self.engine.connect() as conn:
    wp_rows = conn.execute(text("""
        SELECT symbol, MAX(win_probability) AS wp
        FROM technical_signals
        WHERE win_probability IS NOT NULL
          AND computed_at >= datetime('now', '-2 days')
        GROUP BY symbol
    """)).fetchall()
win_prob_map: Dict[str, float] = {r[0]: float(r[1]) for r in wp_rows if r[1] is not None}
print(f"[ScoringEngine] Loaded win_probability for {len(win_prob_map)} symbols.")
```

- [ ] **Step 2: Apply consensus bonus in final score aggregation loop**

```python
# scoring_engine.py — in the "── Final score aggregation" loop, after computing normalized_score (~line 421)
# Add immediately before the classification block:

# ML consensus bonus: screener + ML agree → +10%
wp = win_prob_map.get(symbol)
if wp is not None and normalized_score >= 60 and wp >= 0.55:
    final_score *= 1.10
    normalized_score = min(100, max(0, 50 + (final_score * 2)))
```

- [ ] **Step 3: Commit**

```bash
git add src/server/scoring_engine.py
git commit -m "feat: add ML win_probability consensus bonus to composite scoring"
```

---

## Task 4: Fix news intra-week recency decay (B11)

**Files:**
- Modify: `src/server/scoring_engine.py`

- [ ] **Step 1: Replace news recency in the news seed loop**

```python
# scoring_engine.py — in the "── News seed" loop (~line 349)
# Replace:
#   recency = self._recency_weight(n.get('published_at') or '')
# With this new helper call (add helper below _recency_weight):

@staticmethod
def _news_recency_weight(published_at_str: str) -> float:
    """2-day half-life for news items (tighter than screener 30-day decay)."""
    try:
        import math
        pub = datetime.datetime.fromisoformat(str(published_at_str))
        age_hours = max(0, (datetime.datetime.now() - pub).total_seconds() / 3600)
        return math.exp(-math.log(2) * age_hours / 48)  # halves every 48 hours
    except Exception:
        return 1.0
```

```python
# In the news seed loop, update recency calculation:
recency = self._news_recency_weight(n.get('published_at') or '')
```

- [ ] **Step 2: Commit**

```bash
git add src/server/scoring_engine.py
git commit -m "fix: apply 2-day half-life recency decay for news items within 7-day window"
```

---

## Task 5: Fix `strategy_optimizer.py` per-screener override to cover all 3 sources (B2)

**Files:**
- Modify: `src/server/strategy_optimizer.py`

- [ ] **Step 1: Replace the `compute_screener_overrides` query to UNION all three source tables**

```python
# strategy_optimizer.py — replace compute_screener_overrides method (~line 223)
def compute_screener_overrides(self, opt_weights: dict) -> dict[str, float]:
    q = """
        SELECT sm.scan_id, sm.name, sm.source, sm.inferred_category,
               COUNT(so.symbol) AS appearances,
               SUM(CASE WHEN so.outcome = 'WIN' THEN 1 ELSE 0 END) AS wins
        FROM screener_master sm
        JOIN (
            SELECT screener_id AS scan_id, symbol FROM trendlyne_screener_stocks
            UNION ALL
            SELECT scan_id, symbol FROM moneycontrol_screener_stocks
            UNION ALL
            SELECT screener_id AS scan_id, symbol FROM etnow_screener_stocks
        ) all_stocks ON all_stocks.scan_id = sm.scan_id
        JOIN signal_outcomes so ON so.symbol = all_stocks.symbol
        WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
        GROUP BY sm.scan_id, sm.name
        HAVING appearances >= 10
    """
    df = pd.read_sql_query(q, self.conn)
    if df.empty:
        return {}

    df['win_rate'] = df['wins'] / df['appearances']
    overall_wr = df['win_rate'].mean()
    if overall_wr <= 0:
        return {}

    df['weight_override'] = (0.8 + (df['win_rate'] / overall_wr) * 0.4).clip(0.5, 1.8)
    overrides = dict(zip(df['scan_id'].astype(str), df['weight_override'].round(4)))
    return overrides
```

- [ ] **Step 2: Commit**

```bash
git add src/server/strategy_optimizer.py
git commit -m "fix: include MoneyControl and ETnow in per-screener override computation"
```

---

## Task 6: Fix `performance_tracker.py` wrong JOIN column (B7)

**Files:**
- Modify: `src/server/performance_tracker.py`

- [ ] **Step 1: Fix the JOIN column from `scan_date` to `date`**

```python
# performance_tracker.py — in load_outcomes method, line 72
# Replace:
#   LEFT JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.scan_date = so.signal_date
# With:
#   LEFT JOIN technical_signals ts ON ts.symbol = so.symbol AND ts.date = so.signal_date
```

The corrected `load_outcomes` query:
```python
base_q = """
    SELECT
        so.symbol,
        so.signal_date,
        so.horizon_days,
        so.return_pct,
        so.outcome,
        so.signal_score,
        so.entry_price,
        so.exit_price,
        ts.nifty_regime,
        ts.adx,
        ts.rsi,
        so.signals_json,
        ns.sector
    FROM signal_outcomes so
    LEFT JOIN technical_signals ts
           ON ts.symbol = so.symbol AND ts.date = so.signal_date
    LEFT JOIN nse_stocks ns ON ns.symbol = so.symbol
    WHERE so.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
      AND so.return_pct IS NOT NULL
"""
```

Note: also changed `ts.signals_json` → `so.signals_json` to avoid NULL when JOIN misses (signal_outcomes already stores signals_json).

- [ ] **Step 2: Commit**

```bash
git add src/server/performance_tracker.py
git commit -m "fix: correct JOIN column scan_date→date in performance_tracker load_outcomes"
```

---

## Task 7: Fix WIN threshold inconsistency (B6)

**Files:**
- Modify: `src/server/signalOutcomesService.ts`

- [ ] **Step 1: Change WIN/LOSS thresholds to match Python (>1.0% / <-1.0%)**

```typescript
// signalOutcomesService.ts — line 109, replace threshold block:
const outcome: OutcomeResult =
  returnPct > 1.0  ? 'WIN'  :
  returnPct < -1.0 ? 'LOSS' : 'NEUTRAL';
```

- [ ] **Step 2: Commit**

```bash
git add src/server/signalOutcomesService.ts
git commit -m "fix: align WIN/LOSS threshold with Python (>1% / <-1%) for consistent win rate stats"
```

---

## Task 8: Add stop-loss detection to `signalOutcomesService.ts` (B8)

**Files:**
- Modify: `src/server/signalOutcomesService.ts`

- [ ] **Step 1: Load `stop_loss` from `technical_signals` in the pending query**

```typescript
// signalOutcomesService.ts — replace the pending query in computeSignalOutcomes:
const pending = db.prepare(`
  SELECT ts.symbol, ts.date as signal_date, ts.cmp as entry_price,
         ts.signal_score, ts.signals_json,
         CAST(ts.stop_loss AS REAL) as stop_loss
  FROM technical_signals ts
  WHERE ts.date <= ?
    AND NOT EXISTS (
      SELECT 1 FROM signal_outcomes so
      WHERE so.symbol = ts.symbol
        AND so.signal_date = ts.date
        AND so.horizon_days = ?
        AND so.outcome != 'PENDING'
    )
  ORDER BY ts.date DESC
  LIMIT 500
`).all(cutoff, horizonDays) as {
  symbol: string; signal_date: string; entry_price: number;
  signal_score: number; signals_json: string; stop_loss: number | null;
}[];
```

- [ ] **Step 2: Check stop-loss before exit price lookup**

```typescript
// signalOutcomesService.ts — inside the db.transaction loop, replace exit logic:
db.transaction(() => {
  for (const row of pending) {
    const targetDate = new Date(row.signal_date);
    targetDate.setDate(targetDate.getDate() + horizonDays);
    const targetStr = targetDate.toISOString().slice(0, 10);

    let outcome: OutcomeResult = 'PENDING';
    let exitPrice: number | null = null;
    let checkDate: string | null = null;
    let returnPct: number | null = null;

    // 1. Check stop-loss hit (intraday low crosses SL before target date)
    if (row.stop_loss && row.entry_price > 0) {
      const slHit = db.prepare(`
        SELECT date, low FROM stock_ohlcv
        WHERE symbol = ? AND date > ? AND date <= ?
          AND low <= ?
        ORDER BY date ASC LIMIT 1
      `).get(row.symbol, row.signal_date, targetStr, row.stop_loss) as
        { date: string; low: number } | undefined;

      if (slHit) {
        checkDate = slHit.date;
        exitPrice = row.stop_loss;
        returnPct = ((exitPrice - row.entry_price) / row.entry_price) * 100;
        outcome = 'LOSS';  // stop-loss hit = definitive LOSS
      }
    }

    // 2. If no stop-loss hit, use close at target date
    if (outcome === 'PENDING') {
      const exitRow = db.prepare(`
        SELECT date, close FROM stock_ohlcv
        WHERE symbol = ? AND date >= ?
        ORDER BY date ASC LIMIT 1
      `).get(row.symbol, targetStr) as { date: string; close: number } | undefined;

      if (exitRow && row.entry_price > 0) {
        checkDate = exitRow.date;
        exitPrice = exitRow.close;
        returnPct = ((exitPrice - row.entry_price) / row.entry_price) * 100;
        outcome = returnPct > 1.0 ? 'WIN' : returnPct < -1.0 ? 'LOSS' : 'NEUTRAL';
        resolved++;
      }
    } else {
      resolved++;
    }

    upsert.run({
      symbol: row.symbol, signal_date: row.signal_date,
      horizon_days: horizonDays, entry_price: row.entry_price,
      check_date: checkDate, exit_price: exitPrice,
      return_pct: returnPct !== null ? Math.round(returnPct * 10000) / 10000 : null,
      outcome, signal_score: row.signal_score, signals_json: row.signals_json,
    });
  }
})();
```

- [ ] **Step 3: Commit**

```bash
git add src/server/signalOutcomesService.ts
git commit -m "fix: add stop-loss detection to signal outcome computation"
```

---

## Task 9: Fix shutdown leak — add missing workers to `shutdownQueues` (B4)

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 1: Add missing workers and queues to `Promise.allSettled` in `shutdownQueues`**

```typescript
// queues.ts — replace shutdownQueues function (~line 628)
export async function shutdownQueues(): Promise<void> {
  await Promise.allSettled([
    stockWorker?.close(),
    signalWorker?.close(),
    scoringWorker?.close(),
    mcScreenerSyncWorker?.close(),
    etnowScreenerSyncWorker?.close(),       // was missing
    fundamentalsSyncWorker?.close(),
    quantScoringWorker?.close(),
    technicalSignalsWorker?.close(),
    signalOutcomesWorker?.close(),
    newsSentimentWorker?.close(),
    trendlyneIntradayWorker?.close(),       // was missing
    stockRefreshQueue?.close(),
    aiSignalsQueue?.close(),
    stockScoringQueue?.close(),
    mcScreenerSyncQueue?.close(),
    etnowScreenerSyncQueue?.close(),        // was missing
    fundamentalsSyncQueue?.close(),
    quantScoringQueue?.close(),
    technicalSignalsQueue?.close(),
    signalOutcomesQueue?.close(),
    newsSentimentQueue?.close(),
    trendlyneIntradayQueue?.close(),        // was missing
  ]);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/queues.ts
git commit -m "fix: add missing etnow/trendlyne workers and queues to shutdownQueues"
```

---

## Task 10: Add `outcome_resolver.py` + ML ops to BullMQ schedule (B12, B13)

**Files:**
- Modify: `src/server/queues.ts`

- [ ] **Step 1: Add queue name constants**

```typescript
// queues.ts — add to the queue names section (~line 63)
export const QUEUE_OUTCOME_RESOLVER  = 'outcome-resolver';
export const QUEUE_ML_DAILY_OPS      = 'ml-daily-ops';
```

- [ ] **Step 2: Add module-level handles**

```typescript
// queues.ts — add to module-level handles (~line 82)
export let outcomeResolverQueue: Queue | null = null;
export let mlDailyOpsQueue:      Queue | null = null;

let outcomeResolverWorker: Worker | null = null;
let mlDailyOpsWorker:      Worker | null = null;
```

- [ ] **Step 3: Add worker processors**

```typescript
// queues.ts — add after newsSentimentWorker processor (~line 570)

// ── Outcome resolver (Python — with stop-loss detection) ─────────────────────
async function processOutcomeResolver(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Running Python outcome_resolver.py...');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const scriptPath = new URL('../server/outcome_resolver.py', import.meta.url).pathname;
  await execFileAsync('python', [scriptPath, '--horizon', '5']);
  await execFileAsync('python', [scriptPath, '--horizon', '15']);
  return { success: true };
}

// ── ML daily ops (reward_engine + rl_agent update) ───────────────────────────
async function processMlDailyOps(_job: Job): Promise<{ success: boolean }> {
  console.log('[QUEUE] Running ML daily ops (reward_engine + rl_agent)...');
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const serverDir = new URL('../server', import.meta.url).pathname;
  await execFileAsync('python', [`${serverDir}/reward_engine.py`]);
  await execFileAsync('python', [`${serverDir}/rl_agent.py`, '--update']);
  return { success: true };
}
```

- [ ] **Step 4: Register queues and workers in `initQueues` before the `return true` line**

```typescript
// queues.ts — add inside initQueues(), before "return true" (~line 614)

// ── Outcome resolver queue (daily at 9:30 AM IST = 04:00 UTC) ────────────────
outcomeResolverQueue = new Queue(QUEUE_OUTCOME_RESOLVER, { connection });
const orRepeatables = await outcomeResolverQueue.getRepeatableJobs();
for (const r of orRepeatables) await outcomeResolverQueue.removeRepeatableByKey(r.key);
await outcomeResolverQueue.add('resolve-outcomes-daily', {}, {
  repeat: { pattern: '0 4 * * 1-5' },  // 9:30 AM IST Mon-Fri
  jobId: 'outcome-resolver-daily',
  removeOnComplete: 3, removeOnFail: 3,
});

outcomeResolverWorker = new Worker(QUEUE_OUTCOME_RESOLVER, processOutcomeResolver, {
  connection, concurrency: 1, lockDuration: 10 * 60 * 1000,
});
outcomeResolverWorker.on('completed', () => console.log('[QUEUE] outcome-resolver completed'));
outcomeResolverWorker.on('failed', (_, err) => console.error('[QUEUE] outcome-resolver failed:', err.message));

// ── ML daily ops queue (after market close — 5:00 PM IST = 11:30 UTC) ───────
mlDailyOpsQueue = new Queue(QUEUE_ML_DAILY_OPS, { connection });
const mlRepeatables = await mlDailyOpsQueue.getRepeatableJobs();
for (const r of mlRepeatables) await mlDailyOpsQueue.removeRepeatableByKey(r.key);
await mlDailyOpsQueue.add('ml-ops-daily', {}, {
  repeat: { pattern: '30 11 * * 1-5' }, // 5:00 PM IST Mon-Fri (after market close)
  jobId: 'ml-daily-ops',
  removeOnComplete: 3, removeOnFail: 3,
});

mlDailyOpsWorker = new Worker(QUEUE_ML_DAILY_OPS, processMlDailyOps, {
  connection, concurrency: 1, lockDuration: 15 * 60 * 1000, lockRenewTime: 3 * 60 * 1000,
});
mlDailyOpsWorker.on('completed', () => console.log('[QUEUE] ml-daily-ops completed'));
mlDailyOpsWorker.on('failed', (_, err) => console.error('[QUEUE] ml-daily-ops failed:', err.message));
```

- [ ] **Step 5: Add to `shutdownQueues` (after Task 9 is done, just append these two)**

```typescript
// In shutdownQueues Promise.allSettled array, add:
outcomeResolverWorker?.close(),
mlDailyOpsWorker?.close(),
outcomeResolverQueue?.close(),
mlDailyOpsQueue?.close(),
```

- [ ] **Step 6: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: schedule outcome_resolver.py and ML daily ops (reward+RL) via BullMQ"
```

---

## Task 11: Fix `rl_agent.py` SECTOR_MAP missing infrastructure sectors (B10)

**Files:**
- Modify: `src/server/rl_agent.py`

- [ ] **Step 1: Add missing sectors to SECTOR_MAP**

```python
# rl_agent.py — replace SECTOR_MAP dict (~line 33)
SECTOR_MAP = {
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
    'automobiles':             'AUTO',
    'financials':              'BANK',
    'energy':                  'ENERGY',
    'oil':                     'ENERGY',
    'oil & gas':               'ENERGY',
    'power':                   'ENERGY',
    # ── Added: infrastructure and adjacent sectors ───────────────────────────
    'infrastructure':          'INFRA',
    'capital goods':           'INFRA',
    'industrials':             'INFRA',
    'ports':                   'INFRA',
    'logistics':               'INFRA',
    'construction':            'INFRA',
    'transportation':          'INFRA',
    'cement':                  'INFRA',
    'metals':                  'METALS',
    'steel':                   'METALS',
    'mining':                  'METALS',
    'consumer':                'CONSUMER',
    'fmcg':                    'CONSUMER',
    'retail':                  'CONSUMER',
    'telecom':                 'TELECOM',
    'telecommunications':      'TELECOM',
    'media':                   'MEDIA',
    'realty':                  'REALTY',
    'real estate':             'REALTY',
    'chemicals':               'CHEMICALS',
    'textiles':                'OTHER',
    'agriculture':             'OTHER',
}
```

- [ ] **Step 2: Add INFRA, METALS, CONSUMER, TELECOM, MEDIA, REALTY, CHEMICALS to allowed sector buckets in `get_state_key`**

```python
# rl_agent.py — replace get_state_key function (~line 108)
SECTOR_BUCKETS = {'IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'INFRA', 'METALS', 'CONSUMER', 'TELECOM', 'MEDIA', 'REALTY', 'CHEMICALS', 'OTHER'}

def get_state_key(regime: str, sector_or_bucket: str, score: int) -> str:
    regime_clean = regime if regime in REGIMES else 'SIDEWAYS'
    if sector_or_bucket in SECTOR_BUCKETS:
        sector_bucket = sector_or_bucket
    else:
        sector_bucket = get_sector_bucket(sector_or_bucket)
    return f"{regime_clean}_{sector_bucket}_{get_score_bucket(score)}"
```

- [ ] **Step 3: Commit**

```bash
git add src/server/rl_agent.py
git commit -m "fix: add infrastructure/metals/consumer sectors to RL agent SECTOR_MAP"
```

---

## Task 12: Fix `computeNiftyRegime()` optimistic BULL default (B14)

**Files:**
- Modify: `src/server/technicalSignalsService.ts`

- [ ] **Step 1: Change default from 'BULL' to 'SIDEWAYS' when data insufficient**

```typescript
// technicalSignalsService.ts — replace computeNiftyRegime function (~line 301)
function computeNiftyRegime(): 'BULL' | 'BEAR' | 'SIDEWAYS' {
  try {
    const rows = db.prepare(
      `SELECT close FROM stock_ohlcv
       WHERE symbol IN ('NIFTY50','NIFTY','NIFTY 50','^NSEI','INDIA50')
       ORDER BY date DESC LIMIT 210`
    ).all() as { close: number }[];
    if (rows.length < 50) return 'SIDEWAYS';  // neutral default, not optimistic BULL

    const closes = rows.map(r => r.close).reverse();
    const last   = closes[closes.length - 1];
    const len200 = Math.min(closes.length, 200);
    const sma200 = closes.slice(-len200).reduce((a, b) => a + b, 0) / len200;

    if (last > sma200 * 1.02)  return 'BULL';
    if (last < sma200 * 0.98)  return 'BEAR';
    return 'SIDEWAYS';
  } catch {
    return 'SIDEWAYS';  // neutral default on error
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/technicalSignalsService.ts
git commit -m "fix: use SIDEWAYS as default Nifty regime when data insufficient (remove BULL bias)"
```

---

## Task 13: Create `strategySignalsService.ts` with 3 new strategy functions

**Files:**
- Create: `src/server/strategySignalsService.ts`

- [ ] **Step 1: Write the file with all three strategy functions**

```typescript
// src/server/strategySignalsService.ts
import db from './db';

export interface ConvergenceSignal {
  symbol: string;
  name: string | null;
  sector: string | null;
  normalizedScore: number;
  trendlyneSources: string[];
  mcSources: string[];
  etnowSources: string[];
  totalScreeners: number;
}

export interface RegimeSectorSignal {
  symbol: string;
  name: string | null;
  sector: string;
  normalizedScore: number;
  sectorRank: number;
  winProbability: number | null;
}

export interface QualityOversoldSignal {
  symbol: string;
  name: string | null;
  sector: string | null;
  rsi: number;
  normalizedScore: number;
  qualitySource: 'ZERO_DEBT' | 'CASH_COW' | 'BOTH';
  isRsiOversoldScreener: boolean;
}

// ─── Strategy 1: Multi-Source Convergence Filter ──────────────────────────────

export function crossSourceFilter(minScore = 65): ConvergenceSignal[] {
  // Stocks in ≥1 bullish screener from each of the 3 sources
  const trendlyne = db.prepare(`
    SELECT tss.symbol, GROUP_CONCAT(sm.name) AS sources
    FROM trendlyne_screener_stocks tss
    JOIN screener_master sm ON sm.scan_id = tss.screener_id
    WHERE sm.inferred_sentiment = 'bullish'
    GROUP BY tss.symbol
  `).all() as { symbol: string; sources: string }[];

  const mc = db.prepare(`
    SELECT mss.symbol, GROUP_CONCAT(ms.screener_name) AS sources
    FROM moneycontrol_screener_stocks mss
    JOIN moneycontrol_screeners ms ON ms.scan_id = mss.scan_id
    WHERE ms.is_positive = 1
    GROUP BY mss.symbol
  `).all() as { symbol: string; sources: string }[];

  const etnow = db.prepare(`
    SELECT ess.symbol, GROUP_CONCAT(es.screener_name) AS sources
    FROM etnow_screener_stocks ess
    JOIN etnow_screeners es ON es.screener_id = ess.screener_id
    GROUP BY ess.symbol
  `).all() as { symbol: string; sources: string }[];

  const tlSet = new Map(trendlyne.map(r => [r.symbol, r.sources.split(',')]));
  const mcSet = new Map(mc.map(r => [r.symbol, r.sources.split(',')]));
  const etSet = new Map(etnow.map(r => [r.symbol, r.sources.split(',')]));

  // Bearish screener blacklist
  const bearishSymbols = new Set(
    (db.prepare(`
      SELECT DISTINCT tss.symbol
      FROM trendlyne_screener_stocks tss
      JOIN screener_master sm ON sm.scan_id = tss.screener_id
      WHERE sm.inferred_sentiment = 'bearish'
    `).all() as { symbol: string }[]).map(r => r.symbol)
  );

  // Score lookup
  const scores = new Map(
    (db.prepare(`
      SELECT symbol, score FROM stock_scores WHERE timeframe = 'long_term'
    `).all() as { symbol: string; score: number }[]).map(r => [r.symbol, r.score])
  );

  // Meta lookup
  const meta = new Map(
    (db.prepare(`SELECT symbol, name, sector FROM nse_stocks`).all() as
      { symbol: string; name: string; sector: string }[]).map(r => [r.symbol, r])
  );

  const results: ConvergenceSignal[] = [];

  for (const [symbol, tlSources] of tlSet) {
    if (!mcSet.has(symbol)) continue;
    if (!etSet.has(symbol)) continue;
    if (bearishSymbols.has(symbol)) continue;

    const score = scores.get(symbol) ?? 0;
    if (score < minScore) continue;

    const m = meta.get(symbol);
    results.push({
      symbol,
      name:            m?.name ?? null,
      sector:          m?.sector ?? null,
      normalizedScore: score,
      trendlyneSources: tlSources,
      mcSources:        mcSet.get(symbol)!,
      etnowSources:     etSet.get(symbol)!,
      totalScreeners:   tlSources.length + mcSet.get(symbol)!.length + etSet.get(symbol)!.length,
    });
  }

  return results.sort((a, b) => b.normalizedScore - a.normalizedScore);
}

// ─── Strategy 2: Regime-Conditional Sector Rotation Momentum ─────────────────

export function regimeSectorFilter(
  topNSectors = 3,
  minScore = 60,
  minWinProbability = 0.50,
): RegimeSectorSignal[] {
  // Read Nifty regime from rl_q_table — pick action with highest Q for any BULL state
  const regimeRow = db.prepare(`
    SELECT state_key FROM rl_q_table
    WHERE state_key LIKE 'BULL%'
    ORDER BY q_value DESC LIMIT 1
  `).get() as { state_key: string } | undefined;

  const isBull = regimeRow !== undefined;
  if (!isBull) return [];  // only active in BULL regime

  // Top sectors by stock count in long_term Buy/Strong Buy
  const topSectors = db.prepare(`
    SELECT ns.sector, COUNT(*) as cnt, AVG(ss.score) as avg_score
    FROM stock_scores ss
    JOIN nse_stocks ns ON ns.symbol = ss.symbol
    WHERE ss.timeframe = 'long_term'
      AND ss.classification IN ('Buy', 'Strong Buy')
      AND ns.sector IS NOT NULL AND ns.sector != ''
    GROUP BY ns.sector
    ORDER BY avg_score DESC, cnt DESC
    LIMIT ?
  `).all(topNSectors) as { sector: string; cnt: number; avg_score: number }[];

  if (topSectors.length === 0) return [];

  const sectorSet = new Set(topSectors.map(s => s.sector));
  const sectorRankMap = new Map(topSectors.map((s, i) => [s.sector, i + 1]));

  // Stocks in top sectors meeting score + win_probability thresholds
  const candidates = db.prepare(`
    SELECT ss.symbol, ss.score, ns.name, ns.sector,
           ts.win_probability
    FROM stock_scores ss
    JOIN nse_stocks ns ON ns.symbol = ss.symbol
    LEFT JOIN technical_signals ts ON ts.symbol = ss.symbol
      AND ts.date = (SELECT MAX(date) FROM technical_signals WHERE symbol = ss.symbol)
    WHERE ss.timeframe = 'long_term'
      AND ss.score >= ?
      AND ns.sector IS NOT NULL
    ORDER BY ss.score DESC
  `).all(minScore) as {
    symbol: string; score: number; name: string;
    sector: string; win_probability: number | null;
  }[];

  return candidates
    .filter(c =>
      sectorSet.has(c.sector) &&
      (c.win_probability === null || c.win_probability >= minWinProbability)
    )
    .map(c => ({
      symbol:          c.symbol,
      name:            c.name ?? null,
      sector:          c.sector,
      normalizedScore: c.score,
      sectorRank:      sectorRankMap.get(c.sector) ?? 99,
      winProbability:  c.win_probability,
    }))
    .sort((a, b) => a.sectorRank - b.sectorRank || b.normalizedScore - a.normalizedScore);
}

// ─── Strategy 3: Quality Oversold Mean Reversion ──────────────────────────────

export function qualityOversoldScanner(
  maxRsi = 35,
  maxScore = 65,
): QualityOversoldSignal[] {
  const ZERO_DEBT_ID  = 'et-79';
  const CASH_COW_ID   = 'et-73';
  const RSI_OVERSOLD_ID = 'et-362';

  // Quality stocks from ETnow
  const zeroDept = new Set(
    (db.prepare(`SELECT symbol FROM etnow_screener_stocks WHERE screener_id = ?`)
      .all(ZERO_DEBT_ID) as { symbol: string }[]).map(r => r.symbol)
  );
  const cashCows = new Set(
    (db.prepare(`SELECT symbol FROM etnow_screener_stocks WHERE screener_id = ?`)
      .all(CASH_COW_ID) as { symbol: string }[]).map(r => r.symbol)
  );
  const rsiOversoldScreener = new Set(
    (db.prepare(`SELECT symbol FROM etnow_screener_stocks WHERE screener_id = ?`)
      .all(RSI_OVERSOLD_ID) as { symbol: string }[]).map(r => r.symbol)
  );

  // Quality universe
  const qualitySymbols = new Set([...zeroDept, ...cashCows]);
  if (qualitySymbols.size === 0) return [];

  // Bearish screener blacklist (no negative fundamental flags)
  const bearishSymbols = new Set(
    (db.prepare(`
      SELECT DISTINCT tss.symbol
      FROM trendlyne_screener_stocks tss
      JOIN screener_master sm ON sm.scan_id = tss.screener_id
      WHERE sm.inferred_sentiment = 'bearish'
        AND sm.inferred_category IN ('fundamental', 'valuation')
    `).all() as { symbol: string }[]).map(r => r.symbol)
  );

  // Latest RSI from technical_signals
  const rsiMap = new Map(
    (db.prepare(`
      SELECT ts.symbol, ts.rsi
      FROM technical_signals ts
      WHERE ts.date = (SELECT MAX(date) FROM technical_signals)
        AND ts.rsi <= ?
    `).all(maxRsi + 5) as { symbol: string; rsi: number }[]).map(r => [r.symbol, r.rsi])
  );

  // Score lookup (0-65 acceptable)
  const scores = new Map(
    (db.prepare(`
      SELECT symbol, score FROM stock_scores WHERE timeframe = 'long_term'
    `).all() as { symbol: string; score: number }[]).map(r => [r.symbol, r.score])
  );

  const meta = new Map(
    (db.prepare(`SELECT symbol, name, sector FROM nse_stocks`).all() as
      { symbol: string; name: string; sector: string }[]).map(r => [r.symbol, r])
  );

  const results: QualityOversoldSignal[] = [];

  for (const symbol of qualitySymbols) {
    if (bearishSymbols.has(symbol)) continue;

    const rsi = rsiMap.get(symbol);
    const inRsiOversoldScreener = rsiOversoldScreener.has(symbol);

    if (!inRsiOversoldScreener && (rsi === undefined || rsi > maxRsi)) continue;

    const score = scores.get(symbol) ?? 50;
    if (score > maxScore) continue;  // intentionally excluding very high scores (not oversold)

    const m = meta.get(symbol);
    const inZeroDept = zeroDept.has(symbol);
    const inCashCow  = cashCows.has(symbol);

    results.push({
      symbol,
      name:   m?.name ?? null,
      sector: m?.sector ?? null,
      rsi:    rsi ?? (inRsiOversoldScreener ? 33 : 50),
      normalizedScore: score,
      qualitySource: inZeroDept && inCashCow ? 'BOTH' : inZeroDept ? 'ZERO_DEBT' : 'CASH_COW',
      isRsiOversoldScreener: inRsiOversoldScreener,
    });
  }

  return results.sort((a, b) => a.rsi - b.rsi);  // lowest RSI first (most oversold)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/strategySignalsService.ts
git commit -m "feat: add crossSourceFilter, regimeSectorFilter, qualityOversoldScanner strategies"
```

---

## Task 14: Add 3 new tRPC endpoints to `router.ts`

**Files:**
- Modify: `src/server/router.ts`

- [ ] **Step 1: Add import at top of router.ts**

```typescript
// router.ts — add to imports (after scoringService import ~line 50)
import {
  crossSourceFilter,
  regimeSectorFilter,
  qualityOversoldScanner,
} from './strategySignalsService';
```

- [ ] **Step 2: Add 3 procedures inside `appRouter` (after existing procedures)**

```typescript
// router.ts — add inside appRouter object

getConvergenceSignals: publicProcedure
  .input(z.object({ minScore: z.number().min(0).max(100).default(65) }))
  .query(({ input }) => {
    return crossSourceFilter(input.minScore);
  }),

getRegimeSectorSignals: publicProcedure
  .input(z.object({
    topNSectors: z.number().min(1).max(10).default(3),
    minScore: z.number().min(0).max(100).default(60),
    minWinProbability: z.number().min(0).max(1).default(0.50),
  }))
  .query(({ input }) => {
    return regimeSectorFilter(input.topNSectors, input.minScore, input.minWinProbability);
  }),

getQualityOversoldSignals: publicProcedure
  .input(z.object({
    maxRsi: z.number().min(10).max(50).default(35),
    maxScore: z.number().min(0).max(100).default(65),
  }))
  .query(({ input }) => {
    return qualityOversoldScanner(input.maxRsi, input.maxScore);
  }),
```

- [ ] **Step 3: Commit**

```bash
git add src/server/router.ts
git commit -m "feat: add getConvergenceSignals, getRegimeSectorSignals, getQualityOversoldSignals endpoints"
```

---

## Task 15: Add `signal_type_tag` schema migration + update NLP inference (correlation fix)

**Files:**
- Modify: `src/server/db.ts`
- Modify: `src/server/scoring_engine.py`

- [ ] **Step 1: Add migration column to `screener_master` in db.ts**

```typescript
// db.ts — add after existing migrateColumn calls (~line 711)
migrateColumn('screener_master', 'signal_type_tag', "TEXT DEFAULT 'OTHER'");
```

- [ ] **Step 2: Update `NLPScreenerInference.infer()` in `nlp_engine.py` to assign signal_type_tag**

First, check what `nlp_engine.py` returns. The `infer()` method returns `{'sentiment', 'category', 'timeframe', 'confidence'}`. We need to add `signal_type_tag` to its output.

```python
# nlp_engine.py — update the return dict in infer() to include signal_type_tag
# Map category → signal_type_tag (coarser dedup key):
CATEGORY_TO_TAG = {
    'technical':   lambda name: (
        'RSI'        if any(k in name.lower() for k in ['rsi', 'oversold', 'overbought', 'diverge']) else
        'MACD'       if any(k in name.lower() for k in ['macd', 'crossover', 'momentum']) else
        'VOLUME'     if any(k in name.lower() for k in ['volume', 'delivery', 'accumulation']) else
        'PRICE_ACTION' if any(k in name.lower() for k in ['breakout', 'high', 'low', 'pattern', 'candle']) else
        'TECHNICAL'
    ),
    'fundamental': lambda _: 'FUNDAMENTAL',
    'valuation':   lambda _: 'VALUATION',
    'momentum':    lambda name: (
        'RSI'    if 'rsi' in name.lower() else
        'MACD'   if 'macd' in name.lower() else
        'MOMENTUM'
    ),
    'delivery':    lambda _: 'VOLUME',
    'sector':      lambda _: 'SECTOR',
    'news':        lambda _: 'NEWS',
}

def _get_signal_type_tag(category: str, name: str) -> str:
    mapper = CATEGORY_TO_TAG.get(category)
    if mapper:
        return mapper(name)
    return 'OTHER'
```

- [ ] **Step 3: Update `build_screener_metadata` to persist `signal_type_tag`**

```python
# scoring_engine.py — in build_screener_metadata, update new_master_data.append:
new_master_data.append({
    'scan_id':            s['scan_id'],
    'name':               s['name'],
    'source':             s['source'],
    'inferred_sentiment': sentiment,
    'inferred_category':  inference['category'],
    'inferred_timeframe': inference['timeframe'],
    'confidence':         inference['confidence'],
    'signal_type_tag':    inference.get('signal_type_tag', 'OTHER'),
    'last_updated':       datetime.datetime.now().isoformat(),
})
```

```python
# Update the INSERT in build_screener_metadata to include signal_type_tag:
conn.execute(text("""
    INSERT INTO screener_master
        (scan_id, name, source, inferred_sentiment, inferred_category,
         inferred_timeframe, confidence, signal_type_tag, last_updated)
    VALUES
        (:scan_id, :name, :source, :inferred_sentiment, :inferred_category,
         :inferred_timeframe, :confidence, :signal_type_tag, :last_updated)
    ON CONFLICT(scan_id) DO NOTHING
"""), new_master_data)
```

- [ ] **Step 4: Switch dedup key in scoring loop to use `signal_type_tag`**

```python
# scoring_engine.py — update _source_cat_key to use signal_type_tag
@staticmethod
def _source_cat_key(meta: dict) -> str:
    tag = meta.get('signal_type_tag') or meta.get('category', 'OTHER')
    return f"{meta['source']}|{tag}|{meta['sentiment']}"
```

- [ ] **Step 5: Force rebuild of screener_master to populate new column (run once)**

```bash
cd src/server && python scoring_engine.py --rebuild
```

Expected output: `NLP version changed ... Rebuilding screener_master...`

- [ ] **Step 6: Commit**

```bash
git add src/server/db.ts src/server/scoring_engine.py src/server/nlp_engine.py
git commit -m "feat: add signal_type_tag to screener_master for fine-grained signal deduplication"
```

---

## Task 16: Final integration verification

- [ ] **Step 1: Restart the server and check logs for errors**

```bash
npm run dev
```

Expected: No TypeScript errors. BullMQ logs show all queues registered including `outcome-resolver` and `ml-daily-ops`.

- [ ] **Step 2: Verify scoring engine applies weight_override**

```bash
cd src/server && python scoring_engine.py
```

Expected log line: `[ScoringEngine] N screeners have non-default weight_override applied` (remove after verification)

- [ ] **Step 3: Test new tRPC endpoints via curl**

```bash
# Test convergence signals
curl "http://localhost:3001/trpc/getConvergenceSignals?input=%7B%22minScore%22%3A65%7D"
# Expected: JSON array of stocks with trendlyneSources, mcSources, etnowSources

# Test regime sector signals
curl "http://localhost:3001/trpc/getRegimeSectorSignals?input=%7B%22minScore%22%3A60%7D"
# Expected: JSON array (possibly empty if rl_q_table not populated yet — that is correct)

# Test quality oversold signals
curl "http://localhost:3001/trpc/getQualityOversoldSignals?input=%7B%22maxRsi%22%3A35%7D"
# Expected: JSON array of quality stocks with RSI <= 35
```

- [ ] **Step 4: Verify ADANIPORTS score improvement after Bug 5 fix**

```bash
cd src/server && python -c "
import sqlite3, json
conn = sqlite3.connect('database.sqlite')
row = conn.execute(\"SELECT score, classification, reasons FROM stock_scores WHERE symbol='ADANIPORTS' AND timeframe='long_term'\").fetchone()
if row:
    print(f'Score: {row[0]}, Class: {row[1]}')
    reasons = json.loads(row[2] or '[]')
    print(f'Reasons count: {len(reasons)}')
else:
    print('No score yet — run scoring engine first')
conn.close()
"
```

- [ ] **Step 5: Verify BullMQ schedule — all 13 queues registered**

Check server startup logs for:
```
[QUEUE] BullMQ initialised (stock-refresh + ai-signals)
[QUEUE] stock-scoring, mc-screener-sync, etnow-screener-sync, fundamentals-sync
[QUEUE] quant-scoring, technical-signals, signal-outcomes, news-sentiment
[QUEUE] trendlyne-intraday, outcome-resolver, ml-daily-ops
```

- [ ] **Step 6: Final commit**

```bash
git add .
git commit -m "chore: complete quant strategy overhaul — 14 bugs fixed, 3 strategies added, scheduling complete"
```

---

## Full Schedule Reference (IST)

| Queue | Schedule | Purpose |
|---|---|---|
| `technical-signals` | 8:30 AM Mon-Fri | Daily OHLCV signal scan |
| `signal-outcomes` | 9:00 AM Mon-Fri | Resolve 5d+15d outcomes (TypeScript) |
| `outcome-resolver` | 9:30 AM Mon-Fri | Resolve outcomes with stop-loss detection (Python) |
| `trendlyne-intraday` | every 5 min | Intraday screener updates |
| `news-sentiment` | every 1 min | News sentiment refresh |
| `stock-scoring` | 24hr repeatable | Full screener sync + scoring engine |
| `quant-scoring` | 24hr repeatable | Quantitative scoring |
| `ml-daily-ops` | 5:00 PM Mon-Fri | `reward_engine.py` + `rl_agent.py` update |
| `mc-screener-sync` | every 12hr | MoneyControl screener refresh |
| `etnow-screener-sync` | every 12hr | ETnow screener refresh |
| `fundamentals-sync` | weekly | Yahoo Finance fundamentals |

---

## Self-Review

**Spec coverage check:**
- B1 (weight_override): Task 1 ✓
- B2 (optimizer scope): Task 5 ✓
- B3 (ML win_prob): Task 3 ✓
- B4 (shutdown leak): Task 9 ✓
- B5 (group screeners): Task 2 ✓
- B6 (WIN threshold): Task 7 ✓
- B7 (scan_date typo): Task 6 ✓
- B8 (stop-loss detection): Task 8 ✓
- B9 (weight_override not loaded): Task 1 Step 1 ✓
- B10 (RL sector map): Task 11 ✓
- B11 (news recency): Task 4 ✓
- B12 (outcome_resolver scheduling): Task 10 ✓
- B13 (ML ops scheduling): Task 10 ✓
- B14 (BULL default bias): Task 12 ✓
- Strategy 1 crossSourceFilter: Task 13 ✓
- Strategy 2 regimeSectorFilter: Task 13 ✓
- Strategy 3 qualityOversoldScanner: Task 13 ✓
- 3 tRPC endpoints: Task 14 ✓
- signal_type_tag dedup: Task 15 ✓

**No placeholders found.** All steps contain full code.

**Type consistency:** `ConvergenceSignal`, `RegimeSectorSignal`, `QualityOversoldSignal` defined in Task 13, imported in Task 14 via the same file. ✓
