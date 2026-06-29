# Audit Top-10 Performance & ML Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 10 highest-ROI issues from the June-2025 codebase audit — spanning DB transaction batching, module-level caching, missing indexes, safe connection handling, React memoization, event-loop yielding, and Python ML label correctness.

**Architecture:** Each task is independently committable and testable. Tasks 1–3 are TypeScript backend; Task 4 is pgClient safety (TS); Task 5 is React frontend; Tasks 6–9 are Python ML; Task 10 adds missing Postgres indexes. No cross-task dependencies.

**Tech Stack:** TypeScript/Express/tRPC, React 19, PostgreSQL via `node-postgres`, BullMQ, Python 3 / pandas / scikit-learn, SQLite fallback via `better-sqlite3`.

## Global Constraints

- All TypeScript changes must compile (`npx tsc --noEmit`) — check before committing.
- Python edits must pass existing pytest suites in `src/server/__tests__/`.
- Do not alter existing public function signatures — only add new optional exports.
- Never drop the SQLite `dbAsync` fallback path; changes must work when `USE_POSTGRES=false`.
- `db/schema.postgres.sql` is the canonical schema; SQL migrations must also be reflected there with `CREATE INDEX IF NOT EXISTS`.
- Commit message format: `fix(<scope>): <what changed>`.

---

## Files Modified / Created

| File | Task(s) | Change |
|------|---------|--------|
| `src/server/syncProprietaryScores.ts` | 1 | Batch per-stock upserts into single `dbTransaction` |
| `src/server/niftytraderService.ts` | 2 | Module-level token cache + `invalidateNiftyTraderToken()` |
| `src/server/signals.ts` | 2 | Module-level confidence cache + `invalidateAISignalCache()` |
| `src/server/telegramService.ts` | 2 | Instance-level settings cache; invalidate on `saveSettings` |
| `src/server/routers/telegram.router.ts` | 2 | Call `invalidateNiftyTraderToken()` after saving token |
| `src/server/pgClient.ts` | 4 | Add `withClient<T>()` guaranteed-release wrapper |
| `src/App.tsx` | 5 | Add `useMemo` for `filteredNews` and 4 inline JSX filters |
| `src/server/quantScoringService.ts` | 6 | `setImmediate` yield every 50 symbols in compute loop |
| `src/server/outcome_resolver.py` | 7 | Replace hardcoded 30-day cutoff with `horizon_days` |
| `src/server/ml_ensemble.py` | 8 | Include `STOP_LOSS` in training label query + outcome map |
| `src/server/ml_ensemble.py` | 9 | Regime-adaptive `win_probability` gate via `regime_threshold()` |
| `src/server/relative_strength.py` | 9 | JOIN with `nse_stocks` to exclude index symbols |
| `db/schema.postgres.sql` | 10 | Add two missing indexes |
| `scripts/migrate_add_indexes.sql` | 10 | Idempotent migration script for live DB |

---

## Task 1: Batch proprietary score sync (Priority #1 — eliminates 1,260 txns/run)

**Files:**
- Modify: `src/server/syncProprietaryScores.ts`

**Interfaces:**
- No public API change. `syncNiftyTraderScores()` and `syncTrendlyneScores()` keep the same signature.

---

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/syncProprietaryScores.test.ts`:

```typescript
import { jest } from '@jest/globals';

// We test that dbTransaction is called ONCE per stock, not N times per row.
const mockRun = jest.fn().mockResolvedValue(undefined);
const mockTx = { run: mockRun };
const mockDbTransaction = jest.fn().mockImplementation(async (fn: any) => fn(mockTx));

jest.unstable_mockModule('../dbAsync', () => ({
  dbTransaction: mockDbTransaction,
}));
jest.unstable_mockModule('../niftytraderService', () => ({
  fetchNiftyTraderStockData: jest.fn().mockResolvedValue({
    analysisData: {
      stocktrend: { close: 110, sma_20_days: 100, sma_50_days: 100, sma_200_days: 100, performance_20_days: 5 },
    },
    financialData: { fin_score: 72 },
  }),
}));
jest.unstable_mockModule('../stockMapping', () => ({
  getAllStocks: jest.fn().mockReturnValue([{ symbol: 'INFY' }, { symbol: 'TCS' }]),
}));

const { syncNiftyTraderScores } = await import('../syncProprietaryScores');

test('syncNiftyTraderScores calls dbTransaction once per stock, not once per row', async () => {
  await syncNiftyTraderScores();
  // 2 stocks × 1 transaction each = 2 (was 2 stocks × 2 rows = 4)
  expect(mockDbTransaction).toHaveBeenCalledTimes(2);
  // Both rows for INFY should be in the same tx call
  expect(mockRun).toHaveBeenCalledTimes(4); // 2 rows × 2 stocks
});
```

Run: `npx jest syncProprietaryScores.test --no-coverage`
Expected: FAIL (current code calls `dbTransaction` 4 times for 2 stocks)

---

- [ ] **Step 2: Batch NiftyTrader upserts**

Replace the body of the per-stock try block in `syncNiftyTraderScores`:

```typescript
// OLD: two separate dbTransaction calls per stock
// NEW: collect rows then one transaction per stock

      const stockUpserts: Array<[string, string, string, number, string]> = [];

      const stockTrend = data.analysisData?.stocktrend;
      if (stockTrend) {
        let techScore = 0;
        if (stockTrend.close > stockTrend.sma_20_days) techScore += 1; else techScore -= 1;
        if (stockTrend.close > stockTrend.sma_50_days) techScore += 1; else techScore -= 1;
        if (stockTrend.close > stockTrend.sma_200_days) techScore += 2; else techScore -= 2;
        if (stockTrend.performance_20_days > 0) techScore += 1; else techScore -= 1;

        const normalizedScore = (techScore + 5) * 10;
        let label = 'Neutral';
        if (normalizedScore >= 80) label = 'Very Bullish';
        else if (normalizedScore >= 60) label = 'Bullish';
        else if (normalizedScore <= 20) label = 'Very Bearish';
        else if (normalizedScore <= 40) label = 'Bearish';

        stockUpserts.push([stock.symbol, date, 'technical_rating', normalizedScore, label]);
        count++;
      }

      const finScore = data.financialData?.fin_score;
      if (finScore !== undefined && finScore !== null) {
        stockUpserts.push([stock.symbol, date, 'financial_score', finScore, '']);
      }

      if (stockUpserts.length > 0) {
        await dbTransaction(async (tx) => {
          for (const [sym, dt, scoreType, value, lbl] of stockUpserts) {
            await tx.run(`
              INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
              VALUES (?, ?, 'niftytrader', ?, ?, ?)
              ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
            `, [sym, dt, scoreType, value, lbl]);
          }
        });
      }
```

Also update `syncTrendlyneScores` per-stock try block:

```typescript
      const stockUpserts: Array<[string, string, string, number, string]> = [];

      if (dvm) {
        for (const type of ['quality', 'valuation', 'momentum', 'durability'] as const) {
          const d = (dvm as any)[type];
          if (d) stockUpserts.push([stock.symbol, date, type, d.score, d.insight || '']);
        }
      }

      if (checklist && checklist.score !== undefined) {
        stockUpserts.push([stock.symbol, date, 'checklist', checklist.score, checklist.insight || '']);
      }

      if (stockUpserts.length > 0) {
        await dbTransaction(async (tx) => {
          for (const [sym, dt, scoreType, value, lbl] of stockUpserts) {
            await tx.run(`
              INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
              VALUES (?, ?, 'trendlyne', ?, ?, ?)
              ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
            `, [sym, dt, scoreType, value, lbl]);
          }
        });
        count++;
      }
```

Remove the old `if (dvm) { for (...) { await dbTransaction(...) } }` and `if (checklist ...) { await dbTransaction(...) }` blocks that followed.

---

- [ ] **Step 3: Run test to confirm it passes**

```
npx jest syncProprietaryScores.test --no-coverage
```
Expected: PASS — `mockDbTransaction` called 2 times (once per stock), `mockRun` called 4 times.

---

- [ ] **Step 4: TypeScript compile check**

```
npx tsc --noEmit
```
Expected: 0 errors.

---

- [ ] **Step 5: Commit**

```
git add src/server/syncProprietaryScores.ts src/server/__tests__/syncProprietaryScores.test.ts
git commit -m "fix(sync): batch proprietary score upserts to one tx per stock"
```

---

## Task 2: Cache `app_settings` constants (Priority #2 — eliminates ~200 DB reads/min)

**Files:**
- Modify: `src/server/niftytraderService.ts`
- Modify: `src/server/signals.ts`
- Modify: `src/server/telegramService.ts`
- Modify: `src/server/routers/telegram.router.ts`

---

- [ ] **Step 1: Write the failing test for token cache**

Create `src/server/__tests__/settingsCache.test.ts`:

```typescript
import { jest } from '@jest/globals';

const mockDbGet = jest.fn().mockResolvedValue({ value: 'tok_abc' });
jest.unstable_mockModule('../dbAsync', () => ({ dbGet: mockDbGet, dbRun: jest.fn() }));
jest.unstable_mockModule('../cacheService', () => ({ fetchWithCache: jest.fn() }));

const { getNiftyTraderHeaders, invalidateNiftyTraderToken } = await import('../niftytraderService');

test('getNiftyTraderHeaders reads DB only on first call, then caches', async () => {
  await getNiftyTraderHeaders();
  await getNiftyTraderHeaders();
  await getNiftyTraderHeaders();
  expect(mockDbGet).toHaveBeenCalledTimes(1);
});

test('invalidateNiftyTraderToken forces re-read on next call', async () => {
  mockDbGet.mockClear();
  invalidateNiftyTraderToken();
  await getNiftyTraderHeaders();
  expect(mockDbGet).toHaveBeenCalledTimes(1);
});
```

Run: `npx jest settingsCache.test --no-coverage`
Expected: FAIL (current code calls DB every time).

---

- [ ] **Step 2: Add token cache to `niftytraderService.ts`**

Add at the top of the file (after imports):

```typescript
let _cachedToken: string | null = null;

export function invalidateNiftyTraderToken(): void {
  _cachedToken = null;
}
```

Replace the first ~10 lines of `getNiftyTraderHeaders()`:

```typescript
export async function getNiftyTraderHeaders(): Promise<Record<string, string>> {
  if (_cachedToken === null) {
    try {
      const row = await dbGet<{ value: string }>("SELECT value FROM app_settings WHERE key = 'niftytrader_auth_token'");
      _cachedToken = row?.value ?? '';
    } catch (err: any) {
      console.error('[NIFTYTRADER] Failed to load token from DB:', err.message);
      _cachedToken = '';
    }
  }

  let token = _cachedToken;
  if (!token) {
    token = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjU0MzM4IiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiMCIsIlNlc3Npb25JZCI6IjUwODkiLCJleHAiOjE3ODQ0OTAzNDEsImlzcyI6InByb2QtbmlmdHl0cmFkZXIuaW4iLCJhdWQiOiJwcm9kLW5pZnR5dHJhZGVyLmluIn0.pIFSPRIal82Wxd9tSs2YOr0ipJEjz0f7tow4NrXEwt0";
  }
  if (token && !token.startsWith('Bearer ')) {
    token = `Bearer ${token}`;
  }
  // ... rest of return statement unchanged ...
```

---

- [ ] **Step 3: Wire invalidation in `telegram.router.ts`**

In `saveNiftyTraderToken` mutation, after `await telegramService.saveSettings(...)` (or the equivalent DB save call), add:

```typescript
import { invalidateNiftyTraderToken } from '../niftytraderService';

// inside the saveNiftyTraderToken mutation handler, after saving:
invalidateNiftyTraderToken();
```

---

- [ ] **Step 4: Add confidence cache to `signals.ts`**

Add module-level cache below `DEFAULT_AI_SIGNAL_MIN_CONFIDENCE`:

```typescript
let _cachedMinConfidence: number | null = null;

export function invalidateAISignalCache(): void {
  _cachedMinConfidence = null;
}
```

Replace `getAISignalMinConfidence`:

```typescript
export async function getAISignalMinConfidence(): Promise<number> {
  if (_cachedMinConfidence !== null) return _cachedMinConfidence;
  const row = await dbGet<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'ai_signal_min_confidence'",
  );
  const parsed = row ? Number(row.value) : NaN;
  _cachedMinConfidence = Number.isFinite(parsed) ? parsed : DEFAULT_AI_SIGNAL_MIN_CONFIDENCE;
  return _cachedMinConfidence;
}
```

---

- [ ] **Step 5: Add settings cache to `telegramService.ts`**

Add private cache field to the class:

```typescript
private _settingsCache: { botToken: string; chatId: string; enabled: boolean } | null = null;
```

Update `getSettings()`:

```typescript
private async getSettings(): Promise<{ botToken: string; chatId: string; enabled: boolean }> {
  if (this._settingsCache) return this._settingsCache;
  try {
    const tokenRow   = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_bot_token'") as { value: string } | undefined;
    const chatRow    = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_chat_id'") as { value: string } | undefined;
    const enabledRow = await dbGet("SELECT value FROM app_settings WHERE key = 'telegram_enabled'") as { value: string } | undefined;
    this._settingsCache = {
      botToken: tokenRow?.value || process.env.TELEGRAM_BOT_TOKEN || '',
      chatId:   chatRow?.value  || process.env.TELEGRAM_CHAT_ID   || '',
      enabled:  enabledRow ? enabledRow.value === 'true' : true,
    };
    return this._settingsCache;
  } catch (err) {
    console.error('[TelegramService] Failed to read database configuration:', err);
    return {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId:   process.env.TELEGRAM_CHAT_ID   || '',
      enabled:  true,
    };
  }
}
```

Add cache invalidation at the top of `saveSettings`:

```typescript
public async saveSettings(botToken: string, chatId: string, enabled: boolean): Promise<void> {
  this._settingsCache = null;  // invalidate before writing
  // ... rest unchanged ...
```

---

- [ ] **Step 6: Run test and TypeScript check**

```
npx jest settingsCache.test --no-coverage
npx tsc --noEmit
```
Expected: test PASS, 0 TS errors.

---

- [ ] **Step 7: Commit**

```
git add src/server/niftytraderService.ts src/server/signals.ts src/server/telegramService.ts src/server/routers/telegram.router.ts src/server/__tests__/settingsCache.test.ts
git commit -m "fix(cache): module-level cache for app_settings constants"
```

---

## Task 3: Add `pgClient` safe wrapper (Priority #8 — prevents connection leaks)

**Files:**
- Modify: `src/server/pgClient.ts`

**Interfaces:**
- Produces: `withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>` — exported from `pgClient.ts`.

---

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/pgClient.test.ts`:

```typescript
import { jest } from '@jest/globals';

const mockRelease = jest.fn();
const mockClient = { query: jest.fn(), release: mockRelease };
const mockConnect = jest.fn().mockResolvedValue(mockClient);
jest.unstable_mockModule('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ connect: mockConnect, on: jest.fn() })),
  types: { setTypeParser: jest.fn(), builtins: { INT8: 20 } },
}));

const { withClient } = await import('../pgClient');

test('withClient releases client after success', async () => {
  const result = await withClient(async (c) => { return 42; });
  expect(result).toBe(42);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('withClient releases client even when fn throws', async () => {
  mockRelease.mockClear();
  await expect(withClient(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
```

Run: `npx jest pgClient.test --no-coverage`
Expected: FAIL (`withClient` is not exported yet).

---

- [ ] **Step 2: Add `withClient` to `pgClient.ts`**

Append after the existing `pgClient()` export:

```typescript
/**
 * Acquire a client, run `fn`, and release unconditionally.
 * Prefer this over the raw `pgClient()` export for all explicit transactions.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
```

---

- [ ] **Step 3: Run test and compile check**

```
npx jest pgClient.test --no-coverage
npx tsc --noEmit
```
Expected: PASS, 0 errors.

---

- [ ] **Step 4: Commit**

```
git add src/server/pgClient.ts src/server/__tests__/pgClient.test.ts
git commit -m "fix(pg): add withClient<T> guaranteed-release wrapper"
```

---

## Task 4: React `useMemo` for news filters (Priority #7 — eliminates repeated filter passes)

**Files:**
- Modify: `src/App.tsx`

---

- [ ] **Step 1: Write the test (render smoke test)**

This is a UI change; verify with TypeScript compile rather than unit tests.

```
npx tsc --noEmit
```
Expected: 0 errors (baseline before edits).

---

- [ ] **Step 2: Memoize `filteredNews` at line 404**

The existing line:
```typescript
const filteredNews = news.filter(item => 
  newsFilter === 'All' ? true : item.category === newsFilter
);
```

Replace with:
```typescript
const filteredNews = useMemo(
  () => news.filter(item => newsFilter === 'All' ? true : item.category === newsFilter),
  [news, newsFilter],
);
```

Ensure `useMemo` is already imported from `'react'` at the top of `App.tsx`. If not, add it.

---

- [ ] **Step 3: Memoize FnO signal subsets (lines 2724 and 2747)**

Both are inline `.filter()` calls in JSX. Find the component that renders these (the FnO tab section) and add computed variables above the return. Locate the `fno` data and add above the JSX block that renders "Unusual Options Activity":

```typescript
const unusualSignals = useMemo(
  () => (fno.signals ?? []).filter(s => s.type === 'UNUSUAL_VOLUME' || s.type === 'PCR_SIGNAL'),
  [fno.signals],
);
const oiShiftSignals = useMemo(
  () => (fno.signals ?? []).filter(s => s.type === 'OI_SPIKE' || s.type === 'BUILDUP'),
  [fno.signals],
);
```

Then replace the two inline `.filter(...)` expressions in JSX with `unusualSignals` and `oiShiftSignals` respectively.

---

- [ ] **Step 4: Memoize per-symbol news filters in `NewsTab` and `StockDetailPage` components**

Find `const NewsTab: React.FC<...>` at approximately line 2771.

Replace:
```typescript
const allNews = useNewsFeed();
const news = allNews.filter(n => n.relatedSymbols?.includes(symbol));
```
With:
```typescript
const allNews = useNewsFeed();
const news = useMemo(
  () => allNews.filter(n => n.relatedSymbols?.includes(symbol)),
  [allNews, symbol],
);
```

Find `StockDetailPage` component at approximately line 2836.

Replace:
```typescript
const news = useNewsFeed().filter(n => n.relatedSymbols?.includes(symbol));
```
With:
```typescript
const allNews = useNewsFeed();
const news = useMemo(
  () => allNews.filter(n => n.relatedSymbols?.includes(symbol)),
  [allNews, symbol],
);
```

---

- [ ] **Step 5: TypeScript compile check**

```
npx tsc --noEmit
```
Expected: 0 errors.

---

- [ ] **Step 6: Commit**

```
git add src/App.tsx
git commit -m "fix(perf): useMemo for filteredNews and FnO signal filters"
```

---

## Task 5: Event-loop yield in quant scoring (Priority #6 — unblocks tRPC during nightly run)

**Files:**
- Modify: `src/server/quantScoringService.ts`

---

- [ ] **Step 1: Write the test**

Create `src/server/__tests__/quantScoringYield.test.ts`:

```typescript
// Verify setImmediate is called during computation — proves the event loop is yielded.
const setImmediateSpy = jest.spyOn(global, 'setImmediate');

// Import the helper that wraps setImmediate so we can track calls
// (The actual runQuantScoring is integration-level; we test the yield helper instead)
function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

test('yieldEventLoop resolves via setImmediate', async () => {
  await yieldEventLoop();
  expect(setImmediateSpy).toHaveBeenCalled();
});
```

Run: `npx jest quantScoringYield.test --no-coverage`
Expected: PASS (trivial test — confirms the pattern, not the integration).

---

- [ ] **Step 2: Add yield in the compute loop**

In `quantScoringService.ts`, find the main computation loop that starts around:

```typescript
for (const [symbol, rows] of eligible) {
```

Add a yield every 50 symbols. After the `computed.push({...})` call:

```typescript
    computed.push({
      symbol,
      // ... all fields ...
    });

    // Yield the event loop every 50 symbols to prevent blocking tRPC requests.
    if (computed.length % 50 === 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
```

Also add a single yield between the `percentileRanks` batch calls (between the momentum/risk/valuation rank computation and the upsert phase). Find the block that calls `percentileRanks` multiple times and add after the last rank computation and before the upsert loop:

```typescript
    // Yield after all rank computation before hitting the DB
    await new Promise<void>(resolve => setImmediate(resolve));
```

---

- [ ] **Step 3: TypeScript compile check**

```
npx tsc --noEmit
```
Expected: 0 errors.

---

- [ ] **Step 4: Commit**

```
git add src/server/quantScoringService.ts src/server/__tests__/quantScoringYield.test.ts
git commit -m "fix(perf): yield event loop every 50 symbols in quant scoring"
```

---

## Task 6: Horizon-aware outcome resolver cutoff (Priority #5 — short-horizon signals now resolve)

**Files:**
- Modify: `src/server/outcome_resolver.py` (line 170 only)

**Context:** `resolve_unified_outcomes` already uses `horizon_days` for its cutoff (line 328). Only `resolve_outcomes` (for `technical_signals`/`signal_outcomes`) has the hardcoded 30-day bug.

---

- [ ] **Step 1: Write the failing test**

In `src/server/__tests__/test_outcome_resolver.py`, add:

```python
def test_resolve_outcomes_uses_horizon_not_30_days(monkeypatch):
    """Cutoff must be today - horizon_days, not today - 30 days."""
    import datetime
    captured = {}

    class FakeConn:
        def execute(self, sql, params=()):
            captured['cutoff'] = params[0] if params else None
            return type('R', (), {'fetchall': lambda s: []})()
        def cursor(self): return self

    from outcome_resolver import resolve_outcomes
    resolve_outcomes(FakeConn(), horizon_days=5, dry_run=True)

    expected = (datetime.date.today() - datetime.timedelta(days=5)).isoformat()
    assert captured['cutoff'] == expected, f"Expected cutoff={expected}, got {captured['cutoff']}"
```

Run: `python -m pytest src/server/__tests__/test_outcome_resolver.py::test_resolve_outcomes_uses_horizon_not_30_days -v`
Expected: FAIL (cutoff is 30-day, not 5-day).

---

- [ ] **Step 2: Fix the cutoff**

In `src/server/outcome_resolver.py`, line 170, replace:

```python
    cutoff    = (today - datetime.timedelta(days=30)).isoformat()
```

With:

```python
    cutoff    = (today - datetime.timedelta(days=horizon_days)).isoformat()
```

---

- [ ] **Step 3: Run test**

```
python -m pytest src/server/__tests__/test_outcome_resolver.py::test_resolve_outcomes_uses_horizon_not_30_days -v
```
Expected: PASS.

---

- [ ] **Step 4: Run full test suite to check no regressions**

```
python -m pytest src/server/__tests__/test_outcome_resolver.py -v
```
Expected: all existing tests PASS.

---

- [ ] **Step 5: Commit**

```
git add src/server/outcome_resolver.py src/server/__tests__/test_outcome_resolver.py
git commit -m "fix(ml): outcome resolver cutoff uses horizon_days not 30d hardcode"
```

---

## Task 7: Include STOP_LOSS in ensemble training (Priority #4 — model sees worst outcomes)

**Files:**
- Modify: `src/server/ml_ensemble.py` (two edits)

**Context:** Currently `label_where` at line 282 excludes `STOP_LOSS` rows from training. The `outcome` map at line 365 only maps `WIN` and `LOSS`, leaving `STOP_LOSS` as `NaN` which pandas drops silently. Both must be fixed together.

---

- [ ] **Step 1: Write the failing test**

In `src/server/__tests__/test_ml_ensemble.py`, add:

```python
def test_load_training_data_includes_stop_loss(monkeypatch):
    """STOP_LOSS outcomes must be mapped to 0 (LOSS), not dropped."""
    import pandas as pd
    from ml_ensemble import load_training_data

    fake_rows = [
        {'symbol': 'A', 'signal_date': '2025-01-10', 'horizon_days': 5,
         'outcome': 'WIN',       'signal_score': 70, 'signals_json': '{}', 'return_pct': 3.0,
         'rsi': 55, 'adx': 22, 'nifty_regime': 'BULL', 'cmp': 100, 'sma200': 95,
         'volume_ratio': 1.2, 'fii_3d_net': 100, 'above_sma200': 1, 'pcr_oi': 1.1,
         'pcr_vol': 1.0, 'fii_10d_net': 200, 'dii_3d_net': 50, 'delivery_pct': 60,
         'sector_ret_5d': 0.5, 'sector_ret_21d': 1.2, 'iv_rank': 0.4, 'iv_skew': 0.1,
         'rs_rank_21d': 0.7, 'rs_rank_63d': 0.6, 'insider_buy_pct_90d': 0.2,
         'opening_range_break': 1, 'vwap_deviation_pct': 0.3, 'first_hour_vol_share': 0.25,
         'fifty_two_week_high': 120, 'piotroski_f_score': 7, 'debt_to_equity': 0.3,
         'operating_margins': 0.18, 'return_on_equity': 0.22, 'revenue_growth': 0.12,
         'earnings_growth': 0.15, 'earnings_yield': 0.05, 'price_to_book': 3.0,
         'market_cap': 1e10, 'n_analysts': 5, 'buy_count': 3, 'target_mean': 115,
         'altman_z': 2.5, 'ohlson_o': -2.0},
        {'symbol': 'B', 'signal_date': '2025-01-10', 'horizon_days': 5,
         'outcome': 'STOP_LOSS', 'signal_score': 65, 'signals_json': '{}', 'return_pct': -4.5,
         'rsi': 40, 'adx': 18, 'nifty_regime': 'BEAR', 'cmp': 200, 'sma200': 210,
         'volume_ratio': 0.8, 'fii_3d_net': -50, 'above_sma200': 0, 'pcr_oi': 0.9,
         'pcr_vol': 0.85, 'fii_10d_net': -100, 'dii_3d_net': 20, 'delivery_pct': 45,
         'sector_ret_5d': -1.0, 'sector_ret_21d': -2.5, 'iv_rank': 0.7, 'iv_skew': -0.2,
         'rs_rank_21d': 0.3, 'rs_rank_63d': 0.25, 'insider_buy_pct_90d': 0.0,
         'opening_range_break': 0, 'vwap_deviation_pct': -0.5, 'first_hour_vol_share': 0.15,
         'fifty_two_week_high': 250, 'piotroski_f_score': 4, 'debt_to_equity': 1.2,
         'operating_margins': 0.08, 'return_on_equity': 0.10, 'revenue_growth': -0.05,
         'earnings_growth': -0.10, 'earnings_yield': 0.03, 'price_to_book': 1.5,
         'market_cap': 5e9, 'n_analysts': 3, 'buy_count': 1, 'target_mean': 220,
         'altman_z': 1.8, 'ohlson_o': -0.5},
    ]

    monkeypatch.setattr('ml_ensemble.read_df', lambda q, p=None: pd.DataFrame(fake_rows))
    df = load_training_data(horizon_days=5)

    assert len(df) == 2, f"Expected 2 rows, got {len(df)}: STOP_LOSS row should not be dropped"
    stop_row = df[df.index == 1] if 1 in df.index else df.iloc[1:2]
    # STOP_LOSS must be mapped to 0, not NaN
    assert df['outcome'].notna().all(), "STOP_LOSS must be mapped to 0, not NaN/dropped"
    assert df['outcome'].iloc[1] == 0, "STOP_LOSS must map to 0 (LOSS)"
```

Run: `python -m pytest src/server/__tests__/test_ml_ensemble.py::test_load_training_data_includes_stop_loss -v`
Expected: FAIL (STOP_LOSS row is dropped → len == 1).

---

- [ ] **Step 2: Fix the label query WHERE clause**

In `ml_ensemble.py`, find the `else` branch of the `label` check (around line 280):

```python
    else:
        label_select = "so.outcome"
        label_join = ""
        label_where = "so.outcome IN ('WIN','LOSS')\n          AND so.return_pct IS NOT NULL"
```

Replace `label_where` value:

```python
        label_where = "so.outcome IN ('WIN','LOSS','STOP_LOSS')\n          AND so.return_pct IS NOT NULL"
```

---

- [ ] **Step 3: Fix the outcome map**

Find line 365:

```python
        df['outcome'] = df['outcome'].map({'WIN': 1, 'LOSS': 0})
```

Replace with:

```python
        df['outcome'] = df['outcome'].map({'WIN': 1, 'LOSS': 0, 'STOP_LOSS': 0})
```

---

- [ ] **Step 4: Run test**

```
python -m pytest src/server/__tests__/test_ml_ensemble.py::test_load_training_data_includes_stop_loss -v
```
Expected: PASS.

---

- [ ] **Step 5: Run full ML test suite**

```
python -m pytest src/server/__tests__/test_ml_ensemble.py -v
```
Expected: all existing tests PASS.

---

- [ ] **Step 6: Commit**

```
git add src/server/ml_ensemble.py src/server/__tests__/test_ml_ensemble.py
git commit -m "fix(ml): include STOP_LOSS outcomes in ensemble training as LOSS label"
```

---

## Task 8: Regime-adaptive `win_probability` gate (Priority #9 — BEAR regime signals no longer ignored)

**Files:**
- Modify: `src/server/ml_ensemble.py`

**Context:** The 0.40 gate at line 782 is hard-coded. In BEAR regime, the true base WIN rate is ~37%, so 0.40 is already above base rate — almost every signal gets expired. In BULL regime, the base rate is ~50%, so 0.40 is genuinely selective. The gate should vary with regime.

---

- [ ] **Step 1: Write the failing test**

In `src/server/__tests__/test_ml_ensemble.py`, add:

```python
def test_regime_threshold_varies_by_regime(monkeypatch):
    """Threshold must be lower in BEAR regime and higher in CRASH regime."""
    from ml_ensemble import regime_threshold

    class FakeConn:
        def __init__(self, regime): self._regime = regime
        def execute(self, sql, params=()): return self
        def fetchone(self): return (self._regime,)

    assert regime_threshold(FakeConn('BULL'))    == 0.40
    assert regime_threshold(FakeConn('BEAR'))    == 0.36
    assert regime_threshold(FakeConn('HIGH_VOL'))== 0.38
    assert regime_threshold(FakeConn('CRASH'))   == 0.42
    assert regime_threshold(FakeConn('SIDEWAYS'))== 0.40  # default
```

Run: `python -m pytest src/server/__tests__/test_ml_ensemble.py::test_regime_threshold_varies_by_regime -v`
Expected: FAIL (`regime_threshold` not defined).

---

- [ ] **Step 2: Add `regime_threshold` function to `ml_ensemble.py`**

Add after the existing imports and before `load_training_data`:

```python
_REGIME_THRESHOLDS: dict[str, float] = {
    'BULL':     0.40,   # base rate ~50% → 0.40 is genuinely selective
    'BEAR':     0.36,   # base rate ~37% → 0.40 would kill nearly every signal
    'HIGH_VOL': 0.38,   # elevated uncertainty; slightly more permissive than BULL
    'CRASH':    0.42,   # base rate drops further; require stronger conviction
    'SIDEWAYS': 0.40,   # similar to BULL
}

def regime_threshold(conn: ConnWrapper) -> float:
    """Return the win_probability gate calibrated to the current Nifty regime."""
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'current_nifty_regime'"
    ).fetchone()
    regime = row[0] if row else 'BULL'
    return _REGIME_THRESHOLDS.get(regime, 0.40)
```

---

- [ ] **Step 3: Wire into the recommendation_log expiry block**

Find (around line 777):

```python
        conn.execute("""
            UPDATE recommendation_log
            SET status = 'EXPIRED'
            WHERE win_probability IS NOT NULL
              AND win_probability < 0.40
              AND status = 'ACTIVE'
              AND source = 'technical_scan'
        """)
```

Replace with:

```python
        threshold = regime_threshold(conn)
        conn.execute("""
            UPDATE recommendation_log
            SET status = 'EXPIRED'
            WHERE win_probability IS NOT NULL
              AND win_probability < ?
              AND status = 'ACTIVE'
              AND source = 'technical_scan'
        """, (threshold,))
        print(f"[Ensemble] win_probability gate applied at {threshold:.2f} (regime-adaptive).")
```

---

- [ ] **Step 4: Run test**

```
python -m pytest src/server/__tests__/test_ml_ensemble.py::test_regime_threshold_varies_by_regime -v
```
Expected: PASS.

---

- [ ] **Step 5: Full test suite check**

```
python -m pytest src/server/__tests__/test_ml_ensemble.py -v
```
Expected: all existing tests PASS.

---

- [ ] **Step 6: Commit**

```
git add src/server/ml_ensemble.py src/server/__tests__/test_ml_ensemble.py
git commit -m "fix(ml): regime-adaptive win_probability gate (BEAR=0.36, CRASH=0.42)"
```

---

## Task 9: Filter index symbols from RS universe (Priority #10 — clean cross-sectional ranks)

**Files:**
- Modify: `src/server/relative_strength.py`

**Context:** `stock_ohlcv` may contain index rows (NIFTY50, BANKNIFTY, etc.) that skew cross-sectional percentile ranks. Joining with `nse_stocks` (equity-only, 2000+ stocks) naturally excludes them since indices are not in `nse_stocks`.

---

- [ ] **Step 1: Write the failing test**

In `src/server/__tests__/test_relative_strength.py` (create if missing):

```python
import pandas as pd
import pytest
from unittest.mock import patch

def test_run_excludes_index_symbols(monkeypatch):
    """stock_ohlcv JOIN nse_stocks must filter out index symbols like NIFTY50."""
    queries_executed = []

    def fake_read_df(sql, params=None):
        queries_executed.append(sql)
        return pd.DataFrame(columns=['symbol', 'date', 'close'])

    monkeypatch.setattr('relative_strength.read_df', fake_read_df)
    from relative_strength import run
    run()

    assert queries_executed, "read_df should have been called"
    ohlcv_query = queries_executed[0]
    assert 'JOIN nse_stocks' in ohlcv_query or 'join nse_stocks' in ohlcv_query.lower(), \
        "OHLCV query must JOIN nse_stocks to exclude index symbols"
```

Run: `python -m pytest src/server/__tests__/test_relative_strength.py::test_run_excludes_index_symbols -v`
Expected: FAIL (current query has no JOIN).

---

- [ ] **Step 2: Add the `nse_stocks` JOIN to the OHLCV query**

In `relative_strength.py`, find the `run()` function, `ohlcv = read_df(...)` call (around line 71):

```python
    ohlcv = read_df(
        "SELECT symbol, date, close FROM stock_ohlcv "
        "WHERE date >= ? AND COALESCE(is_suspect,0) = 0 ORDER BY date",
        (cutoff,),
    )
```

Replace with:

```python
    ohlcv = read_df(
        "SELECT o.symbol, o.date, o.close "
        "FROM stock_ohlcv o "
        "JOIN nse_stocks ns ON ns.symbol = o.symbol "
        "WHERE o.date >= ? AND COALESCE(o.is_suspect, 0) = 0 "
        "ORDER BY o.date",
        (cutoff,),
    )
```

---

- [ ] **Step 3: Run test**

```
python -m pytest src/server/__tests__/test_relative_strength.py -v
```
Expected: PASS.

---

- [ ] **Step 4: Commit**

```
git add src/server/relative_strength.py src/server/__tests__/test_relative_strength.py
git commit -m "fix(ml): filter index symbols from RS universe via nse_stocks JOIN"
```

---

## Task 10: Add missing Postgres indexes (Priority #3 — eliminates full-table scans)

**Files:**
- Create: `scripts/migrate_add_indexes.sql`
- Modify: `db/schema.postgres.sql`

**Context:** Two critical indexes are missing:
1. `stock_ohlcv(symbol, date DESC)` — GROUP BY symbol aggregations do full scans today.
2. GIN on `technical_signals.signals_json` — leading-wildcard LIKE (`%RSI_DIVERGENCE%`) can't use B-tree.

Also drop the duplicate `idx_technical_signals_symbol` (redundant with `idx_tsig_sym`).

The GIN index requires `pg_trgm` extension. The schema already has `CREATE EXTENSION IF NOT EXISTS` calls for other extensions — we'll add one for `pg_trgm`.

---

- [ ] **Step 1: Create idempotent migration script**

Create `scripts/migrate_add_indexes.sql`:

```sql
-- Run this against the live Postgres DB once.
-- All statements are idempotent (IF NOT EXISTS / DO NOTHING patterns).

-- Enable trigram extension (needed for GIN on TEXT LIKE queries)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Composite index for GROUP BY symbol queries on stock_ohlcv
CREATE INDEX IF NOT EXISTS idx_stock_ohlcv_sym_date
    ON stock_ohlcv(symbol, date DESC);

-- GIN index for fast leading-wildcard LIKE on signals_json TEXT column
CREATE INDEX IF NOT EXISTS idx_tsig_signals_json_gin
    ON technical_signals USING GIN (signals_json gin_trgm_ops);

-- Remove duplicate symbol index on technical_signals (idx_tsig_sym already exists)
DROP INDEX IF EXISTS idx_technical_signals_symbol;
```

---

- [ ] **Step 2: Add indexes to canonical schema**

In `db/schema.postgres.sql`, find the `stock_ohlcv` index block (around line 1417):

```sql
CREATE INDEX idx_stock_ohlcv_date ON stock_ohlcv(date DESC);
```

Add below it:

```sql
CREATE INDEX IF NOT EXISTS idx_stock_ohlcv_sym_date ON stock_ohlcv(symbol, date DESC);
```

Find the `technical_signals` index block (around line 1582) and add after existing indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_tsig_signals_json_gin ON technical_signals USING GIN (signals_json gin_trgm_ops);
```

Remove or comment the duplicate `idx_technical_signals_symbol` line if it exists.

---

- [ ] **Step 3: Run migration against live DB**

```powershell
$env:PGPASSWORD = "<your-pg-password>"
psql -h localhost -p 5433 -U postgres -d bharat_stocks -f scripts/migrate_add_indexes.sql
```

Expected output:
```
CREATE EXTENSION
CREATE INDEX
CREATE INDEX
DROP INDEX
```

If `pg_trgm` was already installed, the first line will say `NOTICE: extension "pg_trgm" already exists, skipping`.

---

- [ ] **Step 4: Verify indexes exist**

```powershell
psql -h localhost -p 5433 -U postgres -d bharat_stocks -c "\di *ohlcv*"
psql -h localhost -p 5433 -U postgres -d bharat_stocks -c "\di *signals_json*"
```

Expected: `idx_stock_ohlcv_sym_date` and `idx_tsig_signals_json_gin` appear in output.

---

- [ ] **Step 5: Commit**

```
git add scripts/migrate_add_indexes.sql db/schema.postgres.sql
git commit -m "fix(db): add composite ohlcv index + GIN signals_json index; drop duplicate"
```

---

## Self-Review

**Spec coverage check:**

| Priority | Audit finding | Task |
|----------|---------------|------|
| 1 | 360/900 transactions in sync runs | Task 1 |
| 2 | 200+ DB reads/min for constants | Task 2 |
| 3 | Missing composite + GIN indexes | Task 10 |
| 4 | STOP_LOSS excluded from training | Task 7 |
| 5 | 30-day hardcoded outcome cutoff | Task 6 |
| 6 | Event loop blocked by scoring | Task 5 |
| 7 | filteredNews + JSX unmemoized | Task 4 |
| 8 | pgClient no release guarantee | Task 3 |
| 9 | Fixed win_probability gate | Task 8 |
| 10 | Index contamination in RS ranks | Task 9 |

All 10 priorities have a corresponding task. ✓

**Placeholder scan:** No TBD or "implement later" present. All code blocks show actual implementation. ✓

**Type consistency:**
- `invalidateNiftyTraderToken()` defined in Task 2, called in Task 2 (telegram.router). ✓
- `withClient<T>` defined in Task 3, not called in other tasks (standalone improvement). ✓
- `regime_threshold(conn)` defined in Task 8, called in same task. ✓
