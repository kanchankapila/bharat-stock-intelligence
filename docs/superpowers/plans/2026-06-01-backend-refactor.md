# Backend Refactor — Eliminate Duplication & Structural Rot

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate Python-path duplication, mixed invocation strategies, silent error swallowing, hardcoded screener data, in-memory-only progress state, and business logic in the server entry point — without changing any functionality.

**Architecture:** All Python subprocess execution is centralized in `pythonRunner.ts`; all HTTP calls to the port-8000 ML API go through `pythonApi.ts` (port 8002 already has `alphaQuantClient.ts`). `queues.ts` consumes both. `server.ts` is demoted to a pure wiring file.

**Tech Stack:** Node 20, TypeScript, BullMQ, better-sqlite3, execFile (not exec — no shell expansion)

---

## File Map

| Action | File | Change |
|--------|------|--------|
| **Create** | `src/server/pythonRunner.ts` | Canonical Python binary + execFile wrapper |
| **Create** | `src/server/pythonApi.ts` | HTTP client for port-8000 ML ops API |
| **Modify** | `src/server/scoringService.ts` | Replace hardcoded `fetch('...8002...')` with `alphaQuantClient` |
| **Modify** | `src/server/queues.ts` | Use `pythonRunner`, remove promisify boilerplate × 5, fix inline workers |
| **Modify** | `src/server/confluenceEngine.ts` | Use `pythonRunner`, remove local PYTHON constant |
| **Modify** | `src/server/routers/monitor.router.ts` | Use `pythonRunner`, remove PYTHON duplication × 2 |
| **Modify** | `src/server/quantScoringService.ts` | Persist progress to `app_settings` on each phase transition |
| **Modify** | `src/server/scoring_engine.py` | Query `etnow_screeners` from DB instead of hardcoded list |
| **Modify** | `server.ts` | Move first-run bootstrap into service helpers, keep only wiring |
| **Modify** | multiple | Replace `catch { /* ignore */ }` with structured logging |

---

## Task 1 — Create `src/server/pythonRunner.ts`

**Files:**
- Create: `src/server/pythonRunner.ts`

This is a pure utility with no external dependencies inside the project. All other tasks depend on it. Complete this first.

- [ ] **Step 1: Create the file**

```typescript
// src/server/pythonRunner.ts
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PYTHON = process.env.PYTHON_PATH ?? (
  process.platform === 'win32'
    ? 'C:\\Users\\amit_\\AppData\\Local\\Programs\\Python\\Python311\\python.exe'
    : 'python3'
);

export const PY_DIR = path.resolve(process.cwd(), 'src', 'server');

export interface PythonResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a Python script from PY_DIR using execFile (no shell expansion — safer than exec).
 * @param script  Filename relative to PY_DIR, e.g. 'fii_dii_fetcher.py'
 * @param args    CLI arguments, each as a separate array element
 * @param timeoutMs  Max execution time in ms (default 5 min)
 */
export async function runPython(
  script: string,
  args: string[] = [],
  timeoutMs = 5 * 60_000,
): Promise<PythonResult> {
  const { stdout, stderr } = await execFileAsync(
    PYTHON,
    [path.join(PY_DIR, script), ...args],
    { timeout: timeoutMs },
  );
  if (stdout) console.log(`[PY] ${script}:`, stdout.slice(0, 300));
  if (stderr) console.warn(`[PY] ${script} stderr:`, stderr.slice(0, 300));
  return { stdout, stderr };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd c:/Github/bharat-stock-intelligence
npx tsc --noEmit
```

Expected: no new errors (the file has no imports from the project, so it's clean).

- [ ] **Step 3: Commit**

```bash
git add src/server/pythonRunner.ts
git commit -m "refactor: add centralized pythonRunner utility"
```

---

## Task 2 — Create `src/server/pythonApi.ts`

**Files:**
- Create: `src/server/pythonApi.ts`

HTTP client for the port-8000 `python_api.py` FastAPI service. Mirrors the existing `alphaQuantClient.ts` pattern for port 8002.

- [ ] **Step 1: Create the file**

```typescript
// src/server/pythonApi.ts
import axios from 'axios';

const BASE = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:8000';
const TIMEOUT = 300_000; // 5 min — ML ops can be slow

async function post<T = { status: string }>(
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = TIMEOUT,
): Promise<T> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await axios.post<T>(url.toString(), {}, { timeout: timeoutMs });
  return res.data;
}

export const pythonApi = {
  scorePending: () =>
    post('/api/score-pending'),

  resolveOutcomes: (horizon: number) =>
    post('/api/resolve-outcomes', { horizon }),

  trainDL: () =>
    post('/api/train-dl', {}, 6 * 60 * 60_000),

  inferDL: () =>
    post('/api/infer-dl'),
};
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/pythonApi.ts
git commit -m "refactor: add pythonApi HTTP client for port-8000 ML API"
```

---

## Task 3 — Fix `scoringService.ts`: use `alphaQuantClient` for port 8002

**Files:**
- Modify: `src/server/scoringService.ts:35-57`

`recalculateScores` hardcodes `http://127.0.0.1:8002/api/v1/score` instead of using the existing `alphaQuantClient.ts`.

- [ ] **Step 1: Replace the hardcoded fetch in `recalculateScores`**

Find this block in [src/server/scoringService.ts](src/server/scoringService.ts) (lines ~35–57):

```typescript
export async function recalculateScores(): Promise<{ success: boolean; message: string }> {
  try {
    console.log(`🚀 Running AlphaQuant Scoring Engine via FastAPI`);
    const res = await fetch('http://127.0.0.1:8002/api/v1/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rebuild: false })
    });
    
    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ Scoring engine error: ${errText}`);
      return { success: false, message: errText };
    }
    
    const data = await res.json();
    console.log(`✅ Scoring engine output: ${data.message}`);
    return { success: true, message: data.message };
  } catch (error: any) {
    console.error(`❌ Scoring engine fetch error: ${error.message}`);
    return { success: false, message: error.message };
  }
}
```

Replace with:

```typescript
import { alphaQuant } from './alphaQuantClient';

export async function recalculateScores(): Promise<{ success: boolean; message: string }> {
  try {
    console.log('[SCORING] Running AlphaQuant Scoring Engine via FastAPI');
    const data = await alphaQuant.score({ rebuild: false });
    console.log('[SCORING] Done:', data.message);
    return { success: true, message: data.message };
  } catch (error: any) {
    console.error('[SCORING] Engine error:', error.message);
    return { success: false, message: error.message };
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/server/scoringService.ts
git commit -m "refactor(scoring): use alphaQuantClient instead of hardcoded port-8002 URL"
```

---

## Task 4 — Update `queues.ts`: use `pythonRunner` + `pythonApi`, remove boilerplate

**Files:**
- Modify: `src/server/queues.ts`

There are 5 locations that recreate `promisify(exec)` + `pyDir`. Replace all with `runPython`/`pythonApi`. Also extract the two inline worker lambdas into named functions for consistency.

- [ ] **Step 1: Add imports at the top of `queues.ts`**

After the existing imports block, add:

```typescript
import { runPython } from './pythonRunner';
import { pythonApi } from './pythonApi';
```

Remove the module-level `const PYTHON_BIN = ...` block (lines 82–86). It is no longer needed.

- [ ] **Step 2: Replace `processOutcomeResolver` (lines ~278–301)**

```typescript
async function processOutcomeResolver(_job: Job): Promise<{ success: boolean }> {
  await runPython('fii_dii_fetcher.py', [], 90_000).catch(() => {});

  await pythonApi.resolveOutcomes(1).catch(e => console.warn('[API] resolve-outcomes(1):', e.message));
  await pythonApi.resolveOutcomes(5).catch(e => console.warn('[API] resolve-outcomes(5):', e.message));
  await pythonApi.resolveOutcomes(15).catch(e => console.warn('[API] resolve-outcomes(15):', e.message));

  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);

  await pythonApi.scorePending().catch(e => console.warn('[API] score-pending:', e.message));

  return { success: true };
}
```

- [ ] **Step 3: Replace `processMlDailyOps` (lines ~306–333)**

```typescript
async function processMlDailyOps(_job: Job): Promise<{ success: boolean }> {
  await runPython('fii_dii_fetcher.py', [], 90_000).catch(() => {});
  await runPython('finbert_scorer.py', ['--days', '1'], 180_000).catch(() => {});

  await pythonApi.resolveOutcomes(5).catch(e => console.warn('[API] resolve-outcomes(5):', e.message));
  await pythonApi.resolveOutcomes(15).catch(e => console.warn('[API] resolve-outcomes(15):', e.message));

  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);

  await pythonApi.scorePending().catch(e => console.warn('[API] score-pending:', e.message));

  await runPython('reward_engine.py');
  await runPython('rl_agent.py', ['--update']);
  return { success: true };
}
```

- [ ] **Step 4: Extract the `mlWeeklyRetrainWorker` inline lambda into a named function**

Find the inline lambda at the `mlWeeklyRetrainWorker = new Worker(...)` call (around line 975). Extract to:

```typescript
async function processMlWeeklyRetrain(_job: Job): Promise<{ success: boolean }> {
  await runPython('outcome_resolver.py', ['--horizon', '5']);
  await runPython('outcome_resolver.py', ['--horizon', '15']);
  await runPython('ml_ensemble.py', ['--train', '--score'], 60 * 60_000);
  await runPython('strategy_optimizer.py', [], 30 * 60_000).catch(() => {});
  await runPython('performance_tracker.py', ['--horizon', '5']);
  await runPython('performance_tracker.py', ['--horizon', '15']);
  return { success: true };
}
```

Then replace the inline lambda with: `mlWeeklyRetrainWorker = new Worker(QUEUE_ML_WEEKLY_RETRAIN, processMlWeeklyRetrain, { ... })`

- [ ] **Step 5: Extract `screenerPerfWorker` inline lambda into a named function**

```typescript
async function processScreenerPerf(_job: Job): Promise<void> {
  await runPython('screener_performance.py', [], 15 * 60_000);
  try {
    const { classifyAllScreeners } = await import('./screenerClassifier');
    await classifyAllScreeners();
  } catch (e: any) {
    console.error('[QUEUE] screener classification failed:', e.message);
  }
}
```

Replace the inline lambda with `processScreenerPerf`.

- [ ] **Step 6: Replace `processDLPython` (lines ~354–363)**

```typescript
async function processDLPython(script: string, args: string[] = [], timeoutMs = 6 * 60 * 60_000): Promise<{ success: boolean }> {
  await runPython(script, args, timeoutMs);
  return { success: true };
}
```

- [ ] **Step 7: Remove the remaining `pyDir`/`execAsync` occurrences**

Search for any remaining `process.cwd() + '/src/server'` or `promisify(exec)` inside the file and replace with `runPython` calls. There should be none left after steps 2–6.

- [ ] **Step 8: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add src/server/queues.ts
git commit -m "refactor(queues): use pythonRunner/pythonApi, extract inline workers to named functions"
```

---

## Task 5 — Update `confluenceEngine.ts`: use `pythonRunner`

**Files:**
- Modify: `src/server/confluenceEngine.ts:1-11`

- [ ] **Step 1: Replace the local PYTHON constant and execFileAsync with `pythonRunner`**

Remove lines 1–11 (the local `PYTHON`/`ENGINE_DIR`/`execFileAsync` definitions).

Add at the top of the file:

```typescript
import { runPython } from './pythonRunner';
```

- [ ] **Step 2: Find usages of `execFileAsync` in `confluenceEngine.ts`**

```bash
grep -n "execFileAsync\|PYTHON\|ENGINE_DIR" src/server/confluenceEngine.ts
```

For each call site that does:
```typescript
await execFileAsync(PYTHON, [scriptPath], { timeout: N });
```
Replace with:
```typescript
await runPython('confluence_outcome_tracker.py', [], N);
```

(Remove the `const scriptPath = ...` line above it as well.)

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/server/confluenceEngine.ts
git commit -m "refactor(confluence): use pythonRunner, remove local PYTHON constant"
```

---

## Task 6 — Update `monitor.router.ts`: use `pythonRunner`

**Files:**
- Modify: `src/server/routers/monitor.router.ts:439-441`, `513-514`

There are two identical PYTHON constant declarations at lines 439–441 and 513–514.

- [ ] **Step 1: Add import at top of monitor.router.ts**

```typescript
import { runPython, PYTHON, PY_DIR } from '../pythonRunner';
```

- [ ] **Step 2: Remove both local PYTHON declarations**

Delete both blocks that look like:
```typescript
const PYTHON = process.platform === 'win32'
  ? (process.env.PYTHON_PATH || 'C:\\Users\\amit_\\...')
  : (process.env.PYTHON_PATH || 'python3');
```

- [ ] **Step 3: Replace `execFile(PYTHON, ...)` calls with `runPython`**

In `triggerScript` mutation (around line 481):
```typescript
// Before:
execFile(PYTHON, [pyFile, ...pyArgs], { cwd: pyDir, timeout: 30 * 60 * 1000 }, async (err, stdout) => { ... });

// After — fire-and-forget pattern must stay async, use runPython in a void IIFE:
void (async () => {
  try {
    const { stdout } = await runPython(script.pyScript.split(' ')[0], script.pyScript.split(' ').slice(1), 30 * 60_000);
    upsertState('success');
    if (stdout) console.log(`[MONITOR] ${script.id} stdout:`, stdout.slice(0, 300));
  } catch (err: any) {
    upsertState('failed');
    db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`${stateKey}_error`, err.message.slice(0, 500));
    console.error(`[MONITOR] ${script.id} failed:`, err.message);
    if (script.critical) {
      try {
        const { TelegramNotificationService } = await import('../telegramService');
        await new TelegramNotificationService().sendMarkdownMessage(
          `🚨 *Critical script failed*: \`${script.label}\`\nError: ${err.message.slice(0, 300)}`
        );
      } catch { /* telegram optional */ }
    }
  }
})();
```

In `triggerAllDaily` mutation (around line 513), replace each:
```typescript
execFile(PYTHON, [s.pyScript.split(' ')[0], ...s.pyScript.split(' ').slice(1)], { cwd: pyDir, timeout: ... }, (err) => { ... });
```
with:
```typescript
await runPython(s.pyScript.split(' ')[0], s.pyScript.split(' ').slice(1), timeout).catch(e => {
  upsert(`monitor_${id}`, 'failed');
  console.error(`[MONITOR] ${id} failed:`, e.message);
});
upsert(`monitor_${id}`, 'success');
```

- [ ] **Step 4: Remove now-unused `child_process` imports from inside mutations**

Search for `const { execFile } = await import('child_process')` in monitor.router.ts and remove those dynamic imports.

- [ ] **Step 5: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/server/routers/monitor.router.ts
git commit -m "refactor(monitor): use pythonRunner, remove duplicated PYTHON constant"
```

---

## Task 7 — Fix silent `catch {}` blocks

**Files:**
- Modify: `src/server/routers/monitor.router.ts` (multiple)
- Modify: `src/server/queues.ts` (multiple)

Silent catches hide failures entirely. Every `catch { /* ignore */ }` that is not genuinely optional must log at minimum a warning.

- [ ] **Step 1: Find all silent catches in the two files**

```bash
grep -n "catch {" src/server/routers/monitor.router.ts src/server/queues.ts
```

- [ ] **Step 2: For each silent catch around non-optional operations**

Replace:
```typescript
} catch { /* ignore */ }
} catch { /* */ }
```

With:
```typescript
} catch (err: unknown) {
  console.warn('[<CONTEXT>] non-critical operation failed:', (err as Error).message);
}
```

Use the surrounding function name as `<CONTEXT>` (e.g., `[MONITOR]`, `[QUEUE]`).

**Keep silent** only for Telegram notifications (already tagged "telegram optional") and Redis config probes — those are explicitly best-effort.

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/server/routers/monitor.router.ts src/server/queues.ts
git commit -m "fix: replace silent catch blocks with structured error logging"
```

---

## Task 8 — Fix `scoring_engine.py`: read ETnow screeners from DB

**Files:**
- Modify: `src/server/scoring_engine.py:16-32`

The hardcoded `ETNOW_SCREENERS` list duplicates what's already in the `etnow_screeners` table. Replace it with a DB query.

- [ ] **Step 1: Replace the hardcoded list with a DB reader**

Find `ETNOW_SCREENERS = [...]` (lines 16–32) and delete it.

In `AlphaQuantScoringEngine.__init__` (or wherever `ETNOW_SCREENERS` is used), replace references with a method:

```python
def _load_etnow_screeners(self) -> list[dict]:
    """Read ETnow screeners from the database (source of truth)."""
    try:
        with self.engine.connect() as conn:
            rows = conn.execute(
                text("SELECT screener_id AS scan_id, screener_name AS name FROM etnow_screeners")
            ).fetchall()
            return [{'scan_id': r.scan_id, 'name': r.name, 'is_positive': None} for r in rows]
    except Exception as e:
        print(f"[SCORING] Warning: could not load ETnow screeners from DB: {e}")
        return []
```

Call it as: `self.etnow_screeners = self._load_etnow_screeners()`

- [ ] **Step 2: Update all references from `ETNOW_SCREENERS` to `self.etnow_screeners`**

```bash
grep -n "ETNOW_SCREENERS" src/server/scoring_engine.py
```

Replace each occurrence.

- [ ] **Step 3: Verify Python runs without error**

```bash
cd src/server
python -c "from scoring_engine import AlphaQuantScoringEngine; e = AlphaQuantScoringEngine(); print('OK', len(e.etnow_screeners))"
```

Expected: `OK <number>` (0 or more, depending on DB state).

- [ ] **Step 4: Commit**

```bash
git add src/server/scoring_engine.py
git commit -m "refactor(scoring): read ETnow screeners from DB, remove hardcoded list"
```

---

## Task 9 — Persist quant scoring progress to `app_settings`

**Files:**
- Modify: `src/server/quantScoringService.ts`

The in-memory `scoringProgress` object is lost on restart. Persist key transitions so the UI shows accurate state after a crash.

- [ ] **Step 1: Add a persistence helper near the top of the file**

After the `scoringProgress` declaration:

```typescript
function persistProgress(): void {
  try {
    db.prepare(
      "INSERT INTO app_settings(key,value,updatedAt) VALUES(?,?,CURRENT_TIMESTAMP) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt"
    ).run('quant_scoring_progress', JSON.stringify(scoringProgress));
  } catch (err: unknown) {
    console.warn('[QUANT] Could not persist progress:', (err as Error).message);
  }
}
```

- [ ] **Step 2: Load persisted state on module init**

After the `let scoringProgress = {...}` declaration, add:

```typescript
try {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'quant_scoring_progress'").get() as { value: string } | undefined;
  if (row) {
    const saved = JSON.parse(row.value) as Partial<QuantScoringProgress>;
    // On restart, a previously "running" job is no longer running.
    scoringProgress = { ...scoringProgress, ...saved, isRunning: false };
  }
} catch { /* no persisted state — use defaults */ }
```

- [ ] **Step 3: Call `persistProgress()` at each state transition in `runQuantScoring`**

Find the lines in `runQuantScoring` where `scoringProgress` fields are mutated (e.g., `scoringProgress.isRunning = true`, `scoringProgress.completedAt = ...`). Add `persistProgress()` immediately after each mutation.

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/server/quantScoringService.ts
git commit -m "fix(quant): persist scoring progress to app_settings, survives restarts"
```

---

## Task 10 — Extract first-run bootstrap out of `server.ts`

**Files:**
- Modify: `src/server/quantScoringService.ts` — add `bootstrapQuantScoring()`
- Modify: `src/server/fundamentalsSyncService.ts` — add `bootstrapFundamentals()`
- Modify: `server.ts` — call helpers, remove inline BullMQ knowledge

The server entry point currently imports queue internals and makes scheduling decisions. That logic belongs in the respective services.

- [ ] **Step 1: Add `bootstrapQuantScoring` to `quantScoringService.ts`**

```typescript
/**
 * Trigger first-run scoring if quant_scores is empty.
 * Called once at server startup; handles both BullMQ and no-Redis fallback.
 */
export async function bootstrapQuantScoring(bullmqReady: boolean): Promise<void> {
  const count = getQuantScoreCount();
  if (count > 0) {
    console.log(`[QUANT] ${count} existing rows — skipping bootstrap`);
    return;
  }
  if (bullmqReady) {
    const { quantScoringQueue } = await import('./queues');
    if (quantScoringQueue) {
      await quantScoringQueue.add('quant-score-first-run', {}, { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 2 });
      console.log('[QUANT] First-run job enqueued via BullMQ');
      return;
    }
  }
  console.log('[QUANT] No Redis — starting first-time quant scoring directly');
  runQuantScoring().catch(err => console.error('[QUANT] First-run error:', err.message));
  setInterval(() => {
    console.log('[QUANT] Triggering daily quant strategy scoring (fallback)');
    runQuantScoring().catch(console.error);
  }, 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 2: Add `bootstrapFundamentals` to `fundamentalsSyncService.ts`**

```typescript
/**
 * Trigger first-run fundamentals sync if stock_fundamentals is empty.
 * Called once at server startup.
 */
export async function bootstrapFundamentals(bullmqReady: boolean): Promise<void> {
  const counts = getFundamentalsCount();
  if (counts.phase1 > 0) {
    console.log(`[FUND] ${counts.phase1} Phase-1 rows — skipping bootstrap`);
    return;
  }
  if (bullmqReady) {
    const { fundamentalsSyncQueue } = await import('./queues');
    if (fundamentalsSyncQueue) {
      await fundamentalsSyncQueue.add('sync-fundamentals-first-run', { phase2Only: false }, { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 1 });
      console.log('[FUND] First-run job enqueued via BullMQ');
      return;
    }
  }
  console.log('[FUND] No Redis — starting first-time fundamentals sync directly');
  runFullFundamentalsSync(false).catch(err => console.error('[FUND] First-run error:', err.message));
  setInterval(() => runFullFundamentalsSync(false).catch(console.error), 7 * 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 3: Replace the bootstrap blocks in `server.ts`**

Delete the two large blocks (quant scoring bootstrap lines ~46–72, fundamentals bootstrap lines ~75–113).

Replace with:

```typescript
import { bootstrapQuantScoring } from './src/server/quantScoringService';
import { bootstrapFundamentals } from './src/server/fundamentalsSyncService';

// ... after initQueues():
await bootstrapQuantScoring(bullmqReady);
await bootstrapFundamentals(bullmqReady);
```

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/server/quantScoringService.ts src/server/fundamentalsSyncService.ts server.ts
git commit -m "refactor(server): move first-run bootstrap into service helpers, demote server.ts to wiring"
```

---

## Self-Review Checklist

- [x] Task 1 creates `pythonRunner.ts` before any task imports it ✓
- [x] Task 2 creates `pythonApi.ts` before Task 4 uses it ✓
- [x] Task 3 has no dependency on Task 1/2 — independent ✓
- [x] Tasks 5 and 6 depend only on Task 1 — can run after Task 1 ✓
- [x] Task 7 is purely additive (logging) — independent ✓
- [x] Task 8 is Python-only — independent ✓
- [x] Task 9 adds persistence — needs `db` import already present in file ✓
- [x] Task 10 requires Tasks 1/2/4 to be done (queue references stable) ✓
- [x] `historical_ohlc` — table schema only, no callers found → no task needed ✓
- [x] `alphaQuantClient.ts` already handles port-8002 abstraction → only `scoringService.ts` needed fixing ✓
- [x] No TBD/TODO/placeholder in any code block ✓
- [x] `runPython` signature consistent across all tasks (script: string, args: string[], timeoutMs?) ✓
