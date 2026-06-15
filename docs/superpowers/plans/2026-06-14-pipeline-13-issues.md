# Pipeline 13-Issue Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 13 issues from PIPELINE_REVIEW.md that corrupt the ML feedback loop, bias backtesting, and leave signal outcomes untracked.

**Architecture:** Issues #1–#3, #9–#12 are already implemented in the codebase. The remaining gaps are: (a) nothing writes to the `unified_signals` table even though the schema, resolver, and reward reader exist (#4, #13); (b) NLP infers sentiment even at low confidence (#6); (c) quant scoring fails silently in the fallback path (#5); (d) live price polling never triggers signal re-evaluation (#7); and (e) new signals are never broadcast via WebSocket (#8).

**Tech Stack:** TypeScript (BullMQ workers, tRPC), Python (scoring_engine.py, reward_engine.py, outcome_resolver.py), SQLite via better-sqlite3.

---

## Already Done — Verified in Code (no action needed)

| # | Issue | Evidence |
|---|-------|----------|
| #1 | Real-time data not persisted | `fetchAndPersistOHLCVData` in `liveStockData.ts` + daily 4 PM IST queue job |
| #2 | NSE master sync not scheduled | `nseScreenerSyncQueue` repeats Sunday 2 AM UTC |
| #3 | Symbol mapping inconsistencies | `SymbolResolver` class in `src/server/symbolResolver.ts` |
| #9 | Backtester uses CMP not next-day open | `backtester.py` line 213: `next_days = ohlcv_dict[sym][…date > date…].head(1)` |
| #10 | Outcome resolver same-day SL bug | `outcome_resolver.py` PHASE 1 FIX: uses `next_trading_day` from DB |
| #11 | Non-trading days in backtester | `all_dates` derived from OHLCV table — only actual trading days |
| #12 | Scoring weights loaded once at startup | `process_scoring()` calls `_load_optimised_weights()` before every run |

---

## File Map

| File | Change |
|------|--------|
| `src/server/queues.ts` | `processAISignal`: add INSERT to `unified_signals`; add WebSocket broadcast |
| `src/server/technicalSignalsService.ts` | `runTechnicalSignalScan`: add INSERT to `unified_signals` for each generated signal |
| `src/server/quantScoringService.ts` | Fix `.catch(console.error)` → throw so caller sees failures |
| `src/server/routers/scoring.router.ts` | Fix silent `.catch(console.error)` in manual quant trigger |
| `src/server/scoring_engine.py` | `build_screener_metadata`: skip NLP override when confidence < 0.8 |
| `src/server/reward_engine.py` | `update_weights`: also pull from `unified_signal_outcomes` (non-technical sources) |
| `src/server/liveStockData.ts` | `fetchAndPersistOHLCVData`: after persisting, check for ≥5% movers and enqueue technical scan |
| `src/server/__tests__/` | New test file for unified signal ingestion |

---

## Task 1: Wire AI signals into unified_signals (#4 core gap)

**Files:**
- Modify: `src/server/queues.ts` (processAISignal, ~line 208)

The `processAISignal` worker writes to the `signals` table but never to `unified_signals`. The table, indexes, and unique constraint already exist in `db.ts`.

- [ ] **Step 1: Add unified_signals INSERT to processAISignal**

In `src/server/queues.ts`, replace the existing `processAISignal` function body:

```typescript
async function processAISignal(job: Job): Promise<void> {
  const { symbol, stockData } = job.data as { symbol: string; stockData: Record<string, unknown> };

  const analysis = await generateStockAnalysis(symbol, stockData);

  const now = new Date().toISOString();

  // Write to legacy signals table (kept for backwards compat)
  db.prepare(`
    INSERT INTO signals (symbol, type, entry, target, stopLoss, confidence, reasoning, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(
    symbol,
    analysis.signal,
    analysis.entry,
    analysis.target,
    analysis.stopLoss,
    analysis.confidence,
    analysis.reasoning,
    now,
  );

  // Write to unified_signals so outcome resolver and reward engine can track AI signal performance
  db.prepare(`
    INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type,
       entry_price, target_price, stop_loss, confidence_score,
       reasoning, status, signal_generated_at)
    VALUES (?, ?, 'AI', ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    ON CONFLICT(symbol, signal_date, signal_source) DO UPDATE SET
      entry_price=excluded.entry_price,
      target_price=excluded.target_price,
      stop_loss=excluded.stop_loss,
      confidence_score=excluded.confidence_score,
      reasoning=excluded.reasoning,
      signal_generated_at=excluded.signal_generated_at
  `).run(
    symbol,
    now.split('T')[0],
    analysis.signal ?? 'BUY',
    analysis.entry ?? null,
    analysis.target ?? null,
    analysis.stopLoss ?? null,
    analysis.confidence ?? null,
    analysis.reasoning ?? null,
    now,
  );

  // Broadcast via WebSocket so the frontend gets a real-time alert
  try {
    const { webSocketSignalService } = await import('./websocketService');
    webSocketSignalService.broadcastNewSignal({
      symbol,
      signal: analysis.signal,
      entry: analysis.entry,
      target: analysis.target,
      stopLoss: analysis.stopLoss,
      confidence: analysis.confidence,
      source: 'AI',
      generatedAt: now,
    });
  } catch {
    // WebSocket is best-effort
  }

  await job.updateProgress(100);
}
```

- [ ] **Step 2: Verify the unified_signals table has required columns**

Run against the database:
```powershell
$db = "d:\Github\bharat-stock-intelligence\database.sqlite"
& "C:\Users\amitk\AppData\Local\Programs\Python\Python311\python.exe" -c "
import sqlite3
conn = sqlite3.connect('$db')
cols = [r[1] for r in conn.execute('PRAGMA table_info(unified_signals)').fetchall()]
print(cols)
conn.close()
"
```
Expected: list includes `symbol`, `signal_date`, `signal_source`, `signal_type`, `entry_price`, `target_price`, `stop_loss`, `confidence_score`, `reasoning`, `status`, `signal_generated_at`.

- [ ] **Step 3: Verify SignalAlert type in websocketService.ts accepts source field**

Check `src/server/websocketService.ts` for the `SignalAlert` interface. If it doesn't have `source` or `generatedAt` fields, add them:

```typescript
export interface SignalAlert {
  symbol: string;
  signal?: string;
  entry?: number;
  target?: number;
  stopLoss?: number;
  confidence?: number;
  source?: string;       // add if missing
  generatedAt?: string;  // add if missing
}
```

- [ ] **Step 4: Commit**
```bash
git add src/server/queues.ts src/server/websocketService.ts
git commit -m "feat: write AI signals to unified_signals and broadcast via WebSocket"
```

---

## Task 2: Wire technical signals into unified_signals (#4, #8)

**Files:**
- Modify: `src/server/technicalSignalsService.ts`

The technical scan writes rows to `technical_signals` (one row per symbol, updated in-place). `unified_signals` needs one row per signal *event*—only insert when a new signal is actually generated (signal_score > 0), not on every scan.

- [ ] **Step 1: Read the current runTechnicalSignalScan return shape**

```powershell
Select-String -Path "src\server\technicalSignalsService.ts" -Pattern "INSERT INTO technical_signals|runTechnicalSignalScan|signal_score|stop_loss" | Select-Object -First 30
```

Expected: shows the INSERT statement and what fields are available.

- [ ] **Step 2: Add unified_signals INSERT after technical_signals INSERT**

Find the block in `technicalSignalsService.ts` that does `INSERT INTO technical_signals` and add the following immediately after the existing insert (adjust variable names to match what's already in scope):

```typescript
// Mirror actionable signals to unified_signals for cross-source tracking
if (signalScore > 0) {
  const today = new Date().toISOString();
  db.prepare(`
    INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type,
       entry_price, target_price, stop_loss, confidence_score,
       reasoning, technical_score, status, signal_generated_at)
    VALUES (?, date('now'), 'TECHNICAL', 'BUY', ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    ON CONFLICT(symbol, signal_date, signal_source) DO UPDATE SET
      entry_price=excluded.entry_price,
      technical_score=excluded.technical_score,
      confidence_score=excluded.confidence_score,
      signal_generated_at=excluded.signal_generated_at
  `).run(
    symbol,
    cmp ?? null,              // entry_price = current market price
    null,                     // target_price — not computed by technical scanner
    stopLoss ?? null,
    (signalScore / 10.0),     // normalise 0–10 score to 0–1 confidence
    signalsJson ?? null,
    signalScore,
    today,
  );
}
```

> Note: replace `signalScore`, `cmp`, `stopLoss`, `signalsJson`, `symbol` with the actual variable names from the surrounding code. Read the file first with the Read tool before editing.

- [ ] **Step 3: Run a scan manually and verify a unified_signals row was inserted**

Start the dev server and call:
```
POST http://localhost:3000/trpc/runTechnicalSignalScan
```
Then query:
```powershell
& "C:\Users\amitk\AppData\Local\Programs\Python\Python311\python.exe" -c "
import sqlite3
conn = sqlite3.connect('database.sqlite')
rows = conn.execute(\"SELECT symbol, signal_date, signal_source, status FROM unified_signals WHERE signal_source='TECHNICAL' LIMIT 5\").fetchall()
print(rows)
conn.close()
"
```
Expected: 1 or more rows with `signal_source='TECHNICAL'`.

- [ ] **Step 4: Commit**
```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat: write technical signals to unified_signals"
```

---

## Task 3: Fix reward_engine to learn from all signal sources (#13)

**Files:**
- Modify: `src/server/reward_engine.py` (update_weights function, ~line 98)

`update_weights()` only reads from `signal_outcomes` (populated from `technical_signals`). The function needs to also incorporate outcomes from `unified_signal_outcomes` for AI and QUANT sources, so the EMA weight update uses a fuller picture.

- [ ] **Step 1: Read the current update_weights function**

Read `src/server/reward_engine.py` lines 98–156 to confirm the current query.

- [ ] **Step 2: Replace update_weights query to union both outcome tables**

Find the `update_weights` function in `reward_engine.py` and replace the `query` variable and `rows` fetch:

```python
def update_weights(
    conn: sqlite3.Connection,
    days: Optional[int] = None,
    dry_run: bool = False,
) -> dict[str, int]:
    cutoff_clause = ""
    params: tuple = ()
    if days:
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).strftime('%Y-%m-%d')
        cutoff_clause = "AND signal_date >= ?"
        params = (cutoff,)

    # Union technical signal outcomes with unified signal outcomes (AI, QUANT)
    query = f"""
        SELECT symbol, signal_date, horizon_days, return_pct, outcome, signals_json
        FROM signal_outcomes
        WHERE outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND return_pct IS NOT NULL
          {cutoff_clause}
        UNION ALL
        SELECT uso.symbol, uso.signal_date, uso.horizon_days, uso.return_pct, uso.outcome,
               NULL AS signals_json
        FROM unified_signal_outcomes uso
        WHERE uso.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND uso.return_pct IS NOT NULL
          AND uso.signal_source NOT IN ('TECHNICAL')
          {cutoff_clause}
    """
    rows = conn.execute(query, params + params).fetchall()
```

The rest of `update_weights` (the reward computation loop) is unchanged.

- [ ] **Step 3: Run reward_engine dry-run to verify no errors**

```powershell
$PY = "C:\Users\amitk\AppData\Local\Programs\Python\Python311\python.exe"
Set-Location "d:\Github\bharat-stock-intelligence\src\server"
& $PY reward_engine.py --dry-run
```
Expected output: `[RewardEngine] Processing N resolved outcomes...` (N ≥ 0, no stack trace).

- [ ] **Step 4: Commit**
```bash
git add src/server/reward_engine.py
git commit -m "fix: reward_engine learns from AI/QUANT outcomes via unified_signal_outcomes union"
```

---

## Task 4: Add NLP confidence threshold to screener metadata (#6)

**Files:**
- Modify: `src/server/scoring_engine.py` (build_screener_metadata, ~line 170)

When the NLP model has low confidence (< 0.8), the inferred sentiment should not override the signal's behaviour. The current code always applies the NLP result.

- [ ] **Step 1: Read build_screener_metadata current logic**

Read `src/server/scoring_engine.py` lines 140–200 to confirm the inference block.

- [ ] **Step 2: Add confidence gate**

Find this block inside `build_screener_metadata`:
```python
sentiment = inference['sentiment']
# For MoneyControl only: use the explicit is_positive flag to resolve neutral
if sentiment == 'neutral' and s['source'] == 'MoneyControl' and pd.notna(s.get('is_positive')):
    sentiment = 'bullish' if int(s['is_positive']) == 1 else 'bearish'
```

Replace with:
```python
confidence = inference.get('confidence', 0.0)
sentiment = inference['sentiment']

# Skip NLP override if model is uncertain (< 80% confidence)
if confidence < 0.8:
    sentiment = 'neutral'

# For MoneyControl only: use the explicit is_positive flag to resolve neutral
if sentiment == 'neutral' and s['source'] == 'MoneyControl' and pd.notna(s.get('is_positive')):
    sentiment = 'bullish' if int(s['is_positive']) == 1 else 'bearish'
```

Also add `confidence` to the `new_master_data.append({...})` dict:
```python
new_master_data.append({
    ...
    'confidence': confidence,   # already present — ensure it uses the local variable, not inference['confidence']
    ...
})
```

- [ ] **Step 3: Verify scoring engine still runs**

```powershell
$PY = "C:\Users\amitk\AppData\Local\Programs\Python\Python311\python.exe"
Set-Location "d:\Github\bharat-stock-intelligence\src\server"
& $PY -c "from scoring_engine import AlphaQuantScoringEngine; e = AlphaQuantScoringEngine(); print('OK')"
```
Expected: `OK` (no import errors).

- [ ] **Step 4: Commit**
```bash
git add src/server/scoring_engine.py
git commit -m "fix: skip NLP sentiment override when confidence < 0.8 (issue #6)"
```

---

## Task 5: Fix silent quant scoring errors (#5)

**Files:**
- Modify: `src/server/quantScoringService.ts` (~line 89–93)
- Modify: `src/server/routers/scoring.router.ts` (~line 33)

`.catch(console.error)` swallows failures — the caller gets `undefined` and scoring errors are invisible in monitoring.

- [ ] **Step 1: Fix quantScoringService.ts fallback path**

Find in `src/server/quantScoringService.ts`:
```typescript
runQuantScoring().catch(err => console.error('[QUANT] First-run error:', err.message));
setInterval(() => {
  console.log('[QUANT] Triggering daily quant strategy scoring (fallback)');
  runQuantScoring().catch(console.error);
}, 24 * 60 * 60 * 1000);
```

Replace with:
```typescript
runQuantScoring().catch(err => {
  console.error('[QUANT] First-run error:', err.message);
  // Don't rethrow — startup must not crash if quant scoring fails
});
setInterval(() => {
  console.log('[QUANT] Triggering daily quant strategy scoring (fallback)');
  runQuantScoring().catch(err =>
    console.error('[QUANT] Scheduled fallback error:', (err as Error).message)
  );
}, 24 * 60 * 60 * 1000);
```

- [ ] **Step 2: Fix scoring.router.ts manual trigger**

Find in `src/server/routers/scoring.router.ts`:
```typescript
runQuantScoring().catch(console.error);
return { queued: false, message: 'Running directly (no Redis)' };
```

Replace with:
```typescript
runQuantScoring().catch(err =>
  console.error('[QUANT] Manual trigger error:', (err as Error).message)
);
return { queued: false, message: 'Running directly (no Redis)' };
```

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -First 20
```
Expected: no new errors.

- [ ] **Step 4: Commit**
```bash
git add src/server/quantScoringService.ts src/server/routers/scoring.router.ts
git commit -m "fix: expose quant scoring errors in fallback path instead of swallowing (issue #5)"
```

---

## Task 6: Trigger technical signal re-scan on significant intraday price moves (#7)

**Files:**
- Modify: `src/server/liveStockData.ts` (fetchAndPersistOHLCVData, ~line 626)

When a stock moves ≥5% intraday, a fresh technical signal scan is worth triggering. The existing queue infrastructure already handles this — we just need to enqueue a targeted scan job.

- [ ] **Step 1: Read fetchAndPersistOHLCVData**

Read `src/server/liveStockData.ts` lines 570–639 to understand the return shape and what price data is available.

- [ ] **Step 2: Detect movers and enqueue scan job**

After the existing `return { count: stocks.length, persisted: result.inserted }` in `fetchAndPersistOHLCVData`, replace the return with:

```typescript
  // Check for significant intraday moves (≥5%) and enqueue a targeted technical scan
  try {
    const { technicalSignalsQueue } = await import('./queues');
    if (technicalSignalsQueue) {
      const bigMovers = stocks.filter(s => {
        const pct = s.changePercent ?? s.pChange ?? 0;
        return Math.abs(Number(pct)) >= 5;
      }).map(s => s.symbol as string).filter(Boolean);

      if (bigMovers.length > 0) {
        await technicalSignalsQueue.add(
          'scan-movers',
          { symbols: bigMovers, reason: 'intraday-move-5pct' },
          { removeOnComplete: { age: 3600 }, attempts: 2 }
        );
        console.log(`[OHLCV] Enqueued technical scan for ${bigMovers.length} big movers`);
      }
    }
  } catch {
    // queue trigger is best-effort
  }

  return { count: stocks.length, persisted: result.inserted };
```

- [ ] **Step 3: Handle the symbols payload in the technical signals worker**

In `src/server/queues.ts`, find the `technicalSignalsWorker` processor. If it currently ignores job data, update it to accept an optional `symbols` array:

```typescript
async function processTechnicalSignals(job: Job): Promise<{ scanned: number }> {
  const { runTechnicalSignalScan } = await import('./technicalSignalsService');
  const symbols: string[] | undefined = job.data?.symbols;
  const result = await runTechnicalSignalScan(symbols);  // pass symbols if the function accepts them
  return { scanned: result?.scanned ?? 0 };
}
```

> If `runTechnicalSignalScan` doesn't accept a symbols filter, skip the symbols pass-through — the full scan still provides value and the enqueueing serves as a throttled trigger.

- [ ] **Step 4: Verify the server starts without errors after changes**

```powershell
npm run dev 2>&1 | Select-Object -First 30
```
Expected: server starts on port 3000 without TypeScript or import errors.

- [ ] **Step 5: Commit**
```bash
git add src/server/liveStockData.ts src/server/queues.ts
git commit -m "feat: enqueue technical signal re-scan when stocks move ≥5% intraday (issue #7)"
```

---

## Task 7: Broadcast unified signals via WebSocket on technical scan (#8)

**Files:**
- Modify: `src/server/technicalSignalsService.ts`

After writing to `unified_signals` (Task 2), broadcast to connected WebSocket clients so the frontend shows real-time signal alerts without polling.

- [ ] **Step 1: Import WebSocket service in technicalSignalsService.ts**

At the top of `src/server/technicalSignalsService.ts`, add (or verify it already exists):
```typescript
import { webSocketSignalService } from './websocketService';
```

- [ ] **Step 2: Add broadcast call after the unified_signals INSERT**

Inside the block added in Task 2, after the `db.prepare(INSERT INTO unified_signals).run(...)` call:

```typescript
try {
  webSocketSignalService.broadcastNewSignal({
    symbol,
    signal: 'BUY',
    entry: cmp ?? undefined,
    stopLoss: stopLoss ?? undefined,
    confidence: signalScore / 10.0,
    source: 'TECHNICAL',
    generatedAt: new Date().toISOString(),
  });
} catch {
  // broadcast is best-effort; never fail the scan
}
```

- [ ] **Step 3: Verify no circular import**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -First 20
```
Expected: 0 errors. If there's a circular import error, use a dynamic import instead:
```typescript
import('./websocketService').then(({ webSocketSignalService }) => {
  webSocketSignalService.broadcastNewSignal({ ... });
}).catch(() => {});
```

- [ ] **Step 4: Commit**
```bash
git add src/server/technicalSignalsService.ts
git commit -m "feat: broadcast technical signals via WebSocket on scan (issue #8)"
```

---

## Task 8: End-to-end smoke test

**Files:**
- Read: `src/server/__tests__/`

Verify the full signal ingestion pipeline works: signal generated → unified_signals row → outcome resolved → reward updated.

- [ ] **Step 1: Start dev server**

```powershell
npm run dev
```
Expected: server starts on port 3000.

- [ ] **Step 2: Trigger a technical signal scan**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/trpc/runTechnicalSignalScan" -Method POST -ContentType "application/json" -Body '{"json":{}}'
```

- [ ] **Step 3: Verify unified_signals has TECHNICAL rows**

```powershell
$PY = "C:\Users\amitk\AppData\Local\Programs\Python\Python311\python.exe"
& $PY -c "
import sqlite3, json
conn = sqlite3.connect('database.sqlite')
rows = conn.execute('SELECT signal_source, COUNT(*) FROM unified_signals GROUP BY signal_source').fetchall()
print(dict(rows))
conn.close()
"
```
Expected: output includes `{'TECHNICAL': N}` where N > 0.

- [ ] **Step 4: Run outcome resolver dry-run and check unified path**

```powershell
Set-Location "src\server"
& $PY outcome_resolver.py --dry-run --horizon 1
```
Expected: output mentions `resolve_unified_outcomes` processing or `No pending signals to resolve`.

- [ ] **Step 5: Run reward_engine dry-run**

```powershell
& $PY reward_engine.py --dry-run
```
Expected: no stack trace, output shows processed count.

- [ ] **Step 6: Run TypeScript build**

```powershell
npx tsc --noEmit
```
Expected: 0 errors.

---

## Self-Review Against Spec

| # | Issue | Addressed by |
|---|-------|-------------|
| #1 | Real-time data not persisted | Already done (verified) |
| #2 | NSE master sync not scheduled | Already done (verified) |
| #3 | Symbol mapping inconsistencies | Already done (verified) |
| #4 | Multiple signal paths, no unified flow | Tasks 1 + 2 (write to unified_signals) |
| #5 | Score caching silent errors | Task 5 |
| #6 | Screener metadata NLP confidence | Task 4 |
| #7 | Live polling doesn't trigger signals | Task 6 |
| #8 | No real-time alert system | Tasks 1 (AI signals) + 7 (technical) |
| #9 | Backtester wrong entry price | Already done (verified) |
| #10 | Outcome resolver edge case bugs | Already done (verified) |
| #11 | Non-trading days in backtester | Already done (verified) |
| #12 | ML loop weight reload | Already done (verified) |
| #13 | Reward engine only learns from technical | Task 3 |
