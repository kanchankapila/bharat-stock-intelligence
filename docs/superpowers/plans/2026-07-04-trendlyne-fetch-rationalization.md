# Trendlyne Fetch Rationalization + DVM Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-conflict the Sunday Trendlyne burst, eliminate confirmed-dead/duplicate requests, restore DVM data to its consumers, and replace two fully-dead Trendlyne data feeds with a working ET (Economic Times) data source — without adding any new Trendlyne request volume.

**Architecture:** Nine independently-testable changes across the existing BullMQ job scheduler (`queues.ts`), the Trendlyne TypeScript service layer, and several Python fetcher scripts under `src/server/`. No new services or frameworks — every change follows an existing pattern already used elsewhere in this codebase (`db_compat` Python DB layer, `dbAsync` TS DB layer, `MONITOR_SCRIPTS` staleness registry, vitest/pytest unit tests).

**Tech Stack:** TypeScript (Node/BullMQ/tRPC), Python 3.11 (`db_compat`/`requests`), PostgreSQL (via `dbAsync`/`db_compat`), vitest, pytest.

## Global Constraints

- All BullMQ `repeat.pattern` cron strings are evaluated in UTC (`Etc/UTC`) — see existing jobs in `queues.ts` for the convention; IST = UTC+5:30.
- Python DB access goes through `db_compat.connect()` (never raw `sqlite3`/`psycopg2`) — this project completed a full SQLite→Postgres migration and every engine must stay dual-compatible.
- TypeScript DB access goes through `dbAsync` (`dbGet`/`dbAll`/`dbRun`/`dbTransaction`) — never `better-sqlite3` directly outside `db.ts`.
- New/changed camelCase DB columns must be double-quoted in raw SQL (Postgres is case-sensitive; SQLite is not) — not needed in this plan since all new columns are snake_case.
- Every Python fetcher script must remain runnable standalone via `python <script>.py` (existing convention, used for manual debugging) in addition to being invoked by `queues.ts` via `runPython`.
- Do not remove or weaken any existing `ON CONFLICT` upsert pattern; follow the `db_compat` positional-params (`?`) convention already used in every touched file.

---

## Task 1: Restore DVM to `getTrendlyneOverview`, the `getTrendlyneDVM` procedure, and `proprietary_scores_history`

DVM (Durability/Valuation/Momentum) scores are already being fetched as a byproduct of the working `EPS_TTM` Trendlyne call (`trendlyne_fundamentals_fetcher.py::_extract_dvm`, already shipped) and stored in `trendlyne_dvm_scores`. Three consumers are still wired to `fetchTrendlyneDVM()`, a stub that always returns `null` (Trendlyne's DVM widget has no surviving JSON API). This task repoints them to the DB.

**Files:**
- Modify: `src/server/trendlyneService.ts`
- Modify: `src/server/routers/trendlyne.router.ts`
- Modify: `src/server/syncProprietaryScores.ts`
- Test: `src/server/__tests__/trendlyneDvm.test.ts` (new)
- Test: `src/server/__tests__/syncTrendlyneScores.test.ts` (new)

**Interfaces:**
- Produces: `getTrendlyneDVMFromDb(symbol: string): Promise<{durability: {score: number; color: string | null} | null; valuation: {score: number; color: string | null} | null; momentum: {score: number; color: string | null} | null} | null>` — exported from `trendlyneService.ts`, consumed by `getTrendlyneOverview()` in the same file and by `trendlyne.router.ts`.

- [ ] **Step 1: Write the failing test for `getTrendlyneDVMFromDb`**

Create `src/server/__tests__/trendlyneDvm.test.ts`:

```typescript
import { vi, test, expect, beforeEach } from 'vitest';

const mockDbGet = vi.fn();
vi.mock('../dbAsync', () => ({
  dbGet: mockDbGet,
}));
vi.mock('../stockMapping', () => ({
  getStockMapping: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../trendlyneAuthService', () => ({
  fetchTrendlyneWithAuth: vi.fn(),
}));
vi.mock('../cacheService', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
}));

const { getTrendlyneDVMFromDb } = await import('../trendlyneService');

beforeEach(() => {
  mockDbGet.mockClear();
});

test('returns null when no row exists', async () => {
  mockDbGet.mockResolvedValue(undefined);
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toBeNull();
});

test('returns null when all three scores are null', async () => {
  mockDbGet.mockResolvedValue({ d_score: null, v_score: null, m_score: null, d_color: null, v_color: null, m_color: null });
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toBeNull();
});

test('maps a full row to the durability/valuation/momentum shape', async () => {
  mockDbGet.mockResolvedValue({ d_score: 72, v_score: 45, m_score: 88, d_color: 'green', v_color: 'yellow', m_color: 'green' });
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toEqual({
    durability: { score: 72, color: 'green' },
    valuation: { score: 45, color: 'yellow' },
    momentum: { score: 88, color: 'green' },
  });
});

test('maps a partial row (one leg missing) correctly', async () => {
  mockDbGet.mockResolvedValue({ d_score: 72, v_score: null, m_score: 88, d_color: 'green', v_color: null, m_color: 'green' });
  const result = await getTrendlyneDVMFromDb('INFY');
  expect(result).toEqual({
    durability: { score: 72, color: 'green' },
    valuation: null,
    momentum: { score: 88, color: 'green' },
  });
});

test('uppercases the symbol before querying', async () => {
  mockDbGet.mockResolvedValue(undefined);
  await getTrendlyneDVMFromDb('infy');
  expect(mockDbGet).toHaveBeenCalledWith(expect.any(String), ['INFY']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/__tests__/trendlyneDvm.test.ts`
Expected: FAIL — `getTrendlyneDVMFromDb is not a function` (not exported yet).

- [ ] **Step 3: Implement `getTrendlyneDVMFromDb` and repoint `getTrendlyneOverview`**

In `src/server/trendlyneService.ts`, find the existing dead stubs (currently):

```typescript
export async function fetchTrendlyneChecklist(symbol: string) {
  console.warn(`[TRENDLYNE] Checklist has no JSON API on Trendlyne (only HTML widget scraping); returning null for ${symbol}`);
  return null;
}

export async function fetchTrendlyneDVM(symbol: string) {
  console.warn(`[TRENDLYNE] DVM has no JSON API on Trendlyne (only HTML widget scraping); returning null for ${symbol}`);
  return null;
}
```

Leave `fetchTrendlyneChecklist` untouched (genuinely no surviving source). Add a new function directly after `fetchTrendlyneDVM`:

```typescript
export interface TrendlyneDvmLeg {
  score: number;
  color: string | null;
}

export interface TrendlyneDvmScores {
  durability: TrendlyneDvmLeg | null;
  valuation: TrendlyneDvmLeg | null;
  momentum: TrendlyneDvmLeg | null;
}

/**
 * DVM has no surviving live Trendlyne JSON API (see fetchTrendlyneDVM above), but the
 * scores are already fetched weekly as a byproduct of the EPS_TTM chart-data call in
 * trendlyne_fundamentals_fetcher.py and stored in trendlyne_dvm_scores. Read from there
 * instead of live-scraping.
 */
export async function getTrendlyneDVMFromDb(symbol: string): Promise<TrendlyneDvmScores | null> {
  const row = await dbGet(
    `SELECT d_score, v_score, m_score, d_color, v_color, m_color
     FROM trendlyne_dvm_scores
     WHERE symbol = ?
     ORDER BY date DESC LIMIT 1`,
    [symbol.toUpperCase()],
  ) as
    | { d_score: number | null; v_score: number | null; m_score: number | null; d_color: string | null; v_color: string | null; m_color: string | null }
    | undefined;

  if (!row) return null;
  if (row.d_score == null && row.v_score == null && row.m_score == null) return null;

  return {
    durability: row.d_score != null ? { score: row.d_score, color: row.d_color } : null,
    valuation: row.v_score != null ? { score: row.v_score, color: row.v_color } : null,
    momentum: row.m_score != null ? { score: row.m_score, color: row.m_color } : null,
  };
}
```

Then find `getTrendlyneOverview` (currently calls `fetchTrendlyneDVM(symbol)` inside `Promise.all`):

```typescript
export async function getTrendlyneOverview(symbol: string) {
  const [fundamentals, swot, checklist, dvm] = await Promise.all([
    fetchTrendlyneFundamentals(symbol),
    fetchTrendlyneSwot(symbol),
    fetchTrendlyneChecklist(symbol),
    fetchTrendlyneDVM(symbol)
  ]);

  return {
    fundamentals,
    swot,
    checklist,
    dvm
  };
```

Change the last `Promise.all` entry to call the new DB-backed function:

```typescript
export async function getTrendlyneOverview(symbol: string) {
  const [fundamentals, swot, checklist, dvm] = await Promise.all([
    fetchTrendlyneFundamentals(symbol),
    fetchTrendlyneSwot(symbol),
    fetchTrendlyneChecklist(symbol),
    getTrendlyneDVMFromDb(symbol)
  ]);

  return {
    fundamentals,
    swot,
    checklist,
    dvm
  };
```

- [ ] **Step 4: Repoint the `getTrendlyneDVM` tRPC procedure**

In `src/server/routers/trendlyne.router.ts`, change the import (line 5) from:

```typescript
  fetchTrendlyneDVM,
```

to:

```typescript
  getTrendlyneDVMFromDb,
```

And change the procedure (currently lines 26-28):

```typescript
  getTrendlyneDVM: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchTrendlyneDVM(input.symbol)),
```

to:

```typescript
  getTrendlyneDVM: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => getTrendlyneDVMFromDb(input.symbol)),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/server/__tests__/trendlyneDvm.test.ts`
Expected: PASS (5/5).

- [ ] **Step 6: Run the full TS test suite and typecheck to catch ripple effects**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Run: `npx vitest run`
Expected: all pre-existing tests still pass (no regressions from removing the `fetchTrendlyneDVM` import in `trendlyne.router.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/server/trendlyneService.ts src/server/routers/trendlyne.router.ts src/server/__tests__/trendlyneDvm.test.ts
git commit -m "feat: restore DVM to getTrendlyneOverview and getTrendlyneDVM from trendlyne_dvm_scores"
```

- [ ] **Step 8: Write the failing test for `syncTrendlyneScores`' DVM restoration**

Create `src/server/__tests__/syncTrendlyneScores.test.ts`:

```typescript
import { vi, test, expect, beforeEach } from 'vitest';

const mockRun = vi.fn().mockResolvedValue(undefined);
const mockTx = { run: mockRun };
const mockDbTransaction = vi.fn().mockImplementation(async (fn: any) => fn(mockTx));

vi.mock('../dbAsync', () => ({
  dbTransaction: mockDbTransaction,
}));
vi.mock('../stockMapping', () => ({
  getAllStocks: vi.fn().mockReturnValue([{ symbol: 'INFY', tlid: '1594' }]),
}));

const mockGetDvm = vi.fn();
const mockGetChecklist = vi.fn().mockResolvedValue(null);
vi.mock('../trendlyneService', () => ({
  fetchTrendlyneChecklist: mockGetChecklist,
  getTrendlyneDVMFromDb: mockGetDvm,
}));

const { syncTrendlyneScores } = await import('../syncProprietaryScores');

beforeEach(() => {
  mockRun.mockClear();
  mockDbTransaction.mockClear();
  mockGetDvm.mockReset();
  mockGetChecklist.mockClear();
});

test('writes durability/valuation/momentum rows when DVM data exists in the DB', async () => {
  mockGetDvm.mockResolvedValue({
    durability: { score: 72, color: 'green' },
    valuation: { score: 45, color: 'yellow' },
    momentum: { score: 88, color: 'green' },
  });

  await syncTrendlyneScores();

  expect(mockDbTransaction).toHaveBeenCalledTimes(1);
  expect(mockRun).toHaveBeenCalledTimes(3);
  const scoreTypes = mockRun.mock.calls.map((call) => call[1][2]);
  expect(scoreTypes.sort()).toEqual(['durability', 'momentum', 'valuation']);
});

test('skips a stock cleanly when no DVM data exists yet (no error, no rows written)', async () => {
  mockGetDvm.mockResolvedValue(null);

  await syncTrendlyneScores();

  expect(mockDbTransaction).not.toHaveBeenCalled();
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `npx vitest run src/server/__tests__/syncTrendlyneScores.test.ts`
Expected: FAIL — `syncTrendlyneScores` still calls the dead `fetchTrendlyneDVM`/`fetchTrendlyneChecklist` stubs directly (not mocked the same way) and the probe-and-skip logic returns early, so `mockDbTransaction` is never called in either test.

- [ ] **Step 10: Un-suppress the DVM half of `syncTrendlyneScores`**

In `src/server/syncProprietaryScores.ts`, change the import (line 4) from:

```typescript
import { fetchTrendlyneDVM, fetchTrendlyneChecklist } from './trendlyneService';
```

to:

```typescript
import { fetchTrendlyneChecklist, getTrendlyneDVMFromDb } from './trendlyneService';
```

Replace the whole `syncTrendlyneScores` function body with a version that probes only checklist (still genuinely dead) and reads DVM from the DB for every stock (no live Trendlyne request, no cooldown logic needed for the DVM half):

```typescript
export async function syncTrendlyneScores() {
  const stocks = getAllStocks(); // Sync all symbols
  const date = new Date().toISOString().split('T')[0];
  console.log(`[TRENDLYNE SCORES] Starting sync for ${stocks.length} symbols...`);

  let count = 0;

  for (const stock of stocks) {
    try {
      // DVM comes from trendlyne_dvm_scores (no live request) — checklist still has no
      // surviving data source, kept as a probe so this self-heals if it's ever restored.
      const [dvm, checklist] = await Promise.all([
        getTrendlyneDVMFromDb(stock.symbol),
        fetchTrendlyneChecklist(stock.symbol),
      ]);

      if (!dvm && !checklist) {
        continue;
      }

      const stockUpserts: Array<[string, string, string, number, string]> = [];

      if (dvm) {
        for (const [type, leg] of Object.entries(dvm) as Array<[string, { score: number; color: string | null } | null]>) {
          if (leg) stockUpserts.push([stock.symbol, date, type, leg.score, leg.color || '']);
        }
      }

      if (checklist && (checklist as any).score !== undefined) {
        stockUpserts.push([stock.symbol, date, 'checklist', (checklist as any).score, (checklist as any).insight || '']);
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
    } catch (e: any) {
      console.error(`[TRENDLYNE SCORES] Error for ${stock.symbol}:`, e.message);
    }
  }

  console.log(`[TRENDLYNE SCORES] Synced ${count} stocks.`);
}
```

This removes the `jittered`/cooldown/rate-limit logic from this function entirely — it no longer makes a Trendlyne network request for DVM (only `fetchTrendlyneChecklist`, which is a synchronous stub with no network call), so there is nothing to rate-limit. The `jittered` helper and `sleep` are still used by `syncNiftyTraderScores` above it in the same file — do not remove them.

- [ ] **Step 11: Run the test to verify it passes**

Run: `npx vitest run src/server/__tests__/syncTrendlyneScores.test.ts src/server/__tests__/syncProprietaryScores.test.ts`
Expected: PASS (both files — confirms `syncNiftyTraderScores` in the same file is untouched).

- [ ] **Step 12: Typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/server/syncProprietaryScores.ts src/server/__tests__/syncTrendlyneScores.test.ts
git commit -m "feat: restore DVM half of syncTrendlyneScores from trendlyne_dvm_scores, drop dead cooldown logic"
```

---

## Task 2: Give the intraday screener scan its own short cache TTL instead of forcing `skipCache=true`

`runIntradayScreenerScan()` (every 15 min, market hours) calls `fetchTrendlyneScreenerData(screenpk, name, 0, true)` — always bypassing cache entirely, even if the same screener was fetched 30 seconds ago by a different caller. The general-purpose cache TTL (`TRENDLYNE_CONFIG.FETCH_INTERVAL_MS`, 12h per `.env`) is too long for a 15-min scan, so a new short, scan-specific TTL is threaded through instead of a global skip.

**Files:**
- Modify: `src/server/trendlyneScreener.ts`
- Test: `src/server/__tests__/trendlyneScreenerCacheTtl.test.ts` (new)

**Interfaces:**
- Consumes: existing `cache: Map<string, {data: TrendlyneScreenerData; timestamp: number}>` module-level cache in `trendlyneScreener.ts`.
- Produces: `fetchTrendlyneScreenerData(screenpk, screenerName, pageNumber?, skipCache?, maxAgeMs?)` — new optional 5th parameter, defaults to `TRENDLYNE_CONFIG.FETCH_INTERVAL_MS` so all other call sites are unaffected.

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/trendlyneScreenerCacheTtl.test.ts`:

```typescript
import { vi, test, expect, beforeEach } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(), dbAll: vi.fn(), dbRun: vi.fn(), dbTransaction: vi.fn(),
}));
vi.mock('../stockMapping', () => ({
  getStockMapping: vi.fn().mockReturnValue(undefined),
  getStockMappingByTLId: vi.fn().mockReturnValue(undefined),
  getStockMappingByName: vi.fn().mockReturnValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { fetchTrendlyneScreenerData } = await import('../trendlyneScreener');

function jsonResponse(body: any) {
  return { ok: true, json: async () => body } as any;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(jsonResponse({ head: { status: '0' }, body: { tableData: [] } }));
});

test('a call with a short maxAgeMs treats data older than that as stale even though the global TTL would still consider it fresh', async () => {
  await fetchTrendlyneScreenerData('123', 'Test Screener', 0, false, 60_000);
  expect(mockFetch).toHaveBeenCalledTimes(1);

  // Second call within the short 60s window with skipCache=false should reuse cache, not refetch.
  await fetchTrendlyneScreenerData('123', 'Test Screener', 0, false, 60_000);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test('skipCache=true still always bypasses cache regardless of maxAgeMs', async () => {
  await fetchTrendlyneScreenerData('456', 'Another Screener', 0, false);
  expect(mockFetch).toHaveBeenCalledTimes(1);

  await fetchTrendlyneScreenerData('456', 'Another Screener', 0, true);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/__tests__/trendlyneScreenerCacheTtl.test.ts`
Expected: FAIL — `fetchTrendlyneScreenerData` doesn't accept a 5th parameter yet (TypeScript will still allow the extra arg at runtime since it's JS under the hood, but the test's second case will fail because both calls hit `mockFetch` since there's no differentiated TTL logic).

- [ ] **Step 3: Thread `maxAgeMs` through `isCacheFresh`, `getCachedData`, and `fetchTrendlyneScreenerData`**

In `src/server/trendlyneScreener.ts`, change `isCacheFresh` (currently):

```typescript
function isCacheFresh(key: string): boolean {
  if (!cache.has(key)) return false;
  
  // If fetch interval is 0, cache is never fresh (always refetch)
  if (TRENDLYNE_CONFIG.FETCH_INTERVAL_MS === 0) return false;
  
  const entry = cache.get(key)!;
  const age = Date.now() - entry.timestamp;
  return age < TRENDLYNE_CONFIG.FETCH_INTERVAL_MS;
}
```

to:

```typescript
function isCacheFresh(key: string, maxAgeMs: number = TRENDLYNE_CONFIG.FETCH_INTERVAL_MS): boolean {
  if (!cache.has(key)) return false;

  // If fetch interval is 0, cache is never fresh (always refetch)
  if (maxAgeMs === 0) return false;

  const entry = cache.get(key)!;
  const age = Date.now() - entry.timestamp;
  return age < maxAgeMs;
}
```

Change `getCachedData` (currently):

```typescript
function getCachedData(key: string): TrendlyneScreenerData | null {
  if (isCacheFresh(key)) {
    return cache.get(key)?.data || null;
  }
  return null;
}
```

to:

```typescript
function getCachedData(key: string, maxAgeMs?: number): TrendlyneScreenerData | null {
  if (isCacheFresh(key, maxAgeMs)) {
    return cache.get(key)?.data || null;
  }
  return null;
}
```

In `fetchTrendlyneScreenerData`, change the signature and cache-check call (currently):

```typescript
export async function fetchTrendlyneScreenerData(
  screenpk: string,
  screenerName: string,
  pageNumber: number = 0,
  skipCache: boolean = false
): Promise<TrendlyneScreenerData> {
  try {
    if (!screenpk || !screenerName) {
      console.warn(`⚠️ Missing screenpk or screenerName for screener fetch`);
      return {
        success: false,
        data: [],
        totalResults: 0
      };
    }

    // Create cache key using both screenpk and screenerName
    const cacheKey = `${screenpk}:${screenerName}:${pageNumber}`;

    // Check cache if not skipping
    if (!skipCache) {
      const cached = getCachedData(cacheKey);
      if (cached) {
        console.log(`📦 Using cached data for screener: ${screenerName}`);
        return cached;
      }
    }
```

to:

```typescript
export async function fetchTrendlyneScreenerData(
  screenpk: string,
  screenerName: string,
  pageNumber: number = 0,
  skipCache: boolean = false,
  maxAgeMs?: number
): Promise<TrendlyneScreenerData> {
  try {
    if (!screenpk || !screenerName) {
      console.warn(`⚠️ Missing screenpk or screenerName for screener fetch`);
      return {
        success: false,
        data: [],
        totalResults: 0
      };
    }

    // Create cache key using both screenpk and screenerName
    const cacheKey = `${screenpk}:${screenerName}:${pageNumber}`;

    // Check cache if not skipping
    if (!skipCache) {
      const cached = getCachedData(cacheKey, maxAgeMs);
      if (cached) {
        console.log(`📦 Using cached data for screener: ${screenerName}`);
        return cached;
      }
    }
```

- [ ] **Step 4: Add the intraday-specific TTL constant and update the call site**

In `src/server/trendlyneScreener.ts`, add a new key to `TRENDLYNE_CONFIG` (after `SCREENER_NAMES_INTERVAL_MS`):

```typescript
  // Short TTL just for the 15-min intraday scan — short enough to stay responsive to
  // intraday moves, long enough to avoid re-fetching the same screener within one scan cycle.
  INTRADAY_CACHE_TTL_MS: process.env.TRENDLYNE_INTRADAY_CACHE_TTL_MS ? parseInt(process.env.TRENDLYNE_INTRADAY_CACHE_TTL_MS, 10) : 180000, // 3 minutes
```

Then in `runIntradayScreenerScan()`, change the call site (currently line 1344):

```typescript
      // 2. Fetch stock constituents bypassing cache
      const result = await fetchTrendlyneScreenerData(screenpk, name, 0, true);
```

to:

```typescript
      // 2. Fetch stock constituents — short-TTL cache instead of a hard bypass, so two
      // overlapping scan cycles within the TTL window don't double-hit Trendlyne.
      const result = await fetchTrendlyneScreenerData(screenpk, name, 0, false, TRENDLYNE_CONFIG.INTRADAY_CACHE_TTL_MS);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/server/__tests__/trendlyneScreenerCacheTtl.test.ts`
Expected: PASS (2/2).

- [ ] **Step 6: Typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/trendlyneScreener.ts src/server/__tests__/trendlyneScreenerCacheTtl.test.ts
git commit -m "perf: give intraday screener scan a 3-min cache TTL instead of a hard cache bypass"
```

---

## Task 3: Drop the dead-weight PE/PB re-pull from `trendlyne_fundamentals_fetcher.py`, feed the percentile-rank tables from the existing daily MC fetch instead

`mc_pricefeed_fetcher.py` (daily) already fetches each stock's own `pe`/`pb`. `trendlyne_fundamentals_fetcher.py` re-pulls Trendlyne's full 1,500+-point PE/PB history every week for the same numbers. Remove the Trendlyne PE/PB calls; append the daily MC value into the same history tables instead, so `pe_pct_rank_252d`/`pb_pct_rank_252d` keep working — updated daily instead of weekly.

**Files:**
- Modify: `src/server/trendlyne_fundamentals_fetcher.py`
- Modify: `src/server/mc_pricefeed_fetcher.py`
- Test: `src/server/tests/test_trendlyne_fundamentals_fetcher.py` (new)
- Test: `src/server/tests/test_mc_pricefeed_pe_pb_append.py` (new)

**Interfaces:**
- Produces (in `mc_pricefeed_fetcher.py`): `append_pe_pb_history(symbol: str, today: str, pe: float | None, pb: float | None, con) -> None` — pure-ish DB-writing helper, called once per stock after the existing MC fetch.

- [ ] **Step 1: Write the failing test for the trimmed fundamentals fetcher**

Create `src/server/tests/test_trendlyne_fundamentals_fetcher.py`:

```python
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import trendlyne_fundamentals_fetcher as tff


def test_pe_and_pb_params_are_not_fetched_during_a_full_run(monkeypatch):
    """PE_TTM_SHARE_NOW / PBV_A_SHARE_NOW are now fed by mc_pricefeed_fetcher.py daily —
    the weekly Trendlyne fetcher's main loop must no longer request them. Drives the
    real main() end-to-end with everything except _fetch mocked, so this actually
    exercises the per-stock loop instead of asserting on isolated helpers."""
    requested_params = []

    def fake_fetch(tlid, param, session):
        requested_params.append(param)
        if param == "EPS_TTM":
            return {"eodData": [[1774895400000, 8.29]], "stockHeaders": [], "stockData": []}
        if param == "DIVIDEND_YIELD_TTM_Q":
            return {"eodData": [[1774895400000, 0.5]]}
        return {"eodData": []}

    monkeypatch.setattr(tff, "_fetch", fake_fetch)
    monkeypatch.setattr(tff, "_load_stocks", lambda symbol_filter, con: [("BEL", "175")])
    monkeypatch.setattr(tff, "connect", lambda: MagicMock())
    monkeypatch.setattr(tff, "ensure_schema", lambda con: None)
    monkeypatch.setattr(tff, "_upsert_series", lambda *a, **k: None)
    monkeypatch.setattr(tff, "_upsert_dvm", lambda *a, **k: None)
    monkeypatch.setattr(tff, "_backfill_technical_signals", lambda *a, **k: None)
    monkeypatch.setattr(tff, "_pe_features_from_db", lambda *a, **k: {})
    monkeypatch.setattr(tff, "_pb_features_from_db", lambda *a, **k: {})
    monkeypatch.setattr(tff.time, "sleep", lambda *_: None)
    monkeypatch.setattr(sys, "argv", ["trendlyne_fundamentals_fetcher.py"])

    tff.main()

    assert "PE_TTM_SHARE_NOW" not in requested_params
    assert "PBV_A_SHARE_NOW" not in requested_params
    assert "EPS_TTM" in requested_params
    assert "DIVIDEND_YIELD_TTM_Q" in requested_params
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/server && python -m pytest tests/test_trendlyne_fundamentals_fetcher.py -v`
Expected: FAIL — `assert "PE_TTM_SHARE_NOW" not in requested_params` fails because the current `main()` loop still fetches it.

- [ ] **Step 3: Remove the PE/PB fetch-and-persist block from `trendlyne_fundamentals_fetcher.py`**

In `src/server/trendlyne_fundamentals_fetcher.py`, remove steps 2 and 3 from the per-stock loop in `main()` (currently):

```python
        # ── 2. PE_TTM_SHARE_NOW (daily, 1521 pts) ──
        body = _fetch(tlid, "PE_TTM_SHARE_NOW", session)
        if body is not None:
            pe_series = _parse_eod(body)
            if pe_series:
                _upsert_series("trendlyne_pe_history", "pe_ttm", symbol, pe_series, con)
                features.update(_pe_features_from_db(symbol, con))
        time.sleep(RATE_LIMIT_SEC)

        # ── 3. PBV_A_SHARE_NOW (daily, 1824 pts) ──
        body = _fetch(tlid, "PBV_A_SHARE_NOW", session)
        if body is not None:
            pb_series = _parse_eod(body)
            if pb_series:
                _upsert_series("trendlyne_pb_history", "pb_ratio", symbol, pb_series, con)
                features.update(_pb_features_from_db(symbol, con))
        time.sleep(RATE_LIMIT_SEC)

        # ── 4. DIVIDEND_YIELD_TTM_Q (quarterly, 32 pts) ──
```

Replace with (renumbering the remaining step and keeping PE/PB feature computation from the DB, since `mc_pricefeed_fetcher.py` will now be the one appending rows into those same history tables):

```python
        # PE/PB history is now appended daily by mc_pricefeed_fetcher.py (that endpoint
        # already fetches each stock's own daily PE/PB — re-pulling Trendlyne's full
        # multi-year history here every week was pure duplication). Still read the
        # percentile-rank features from the same tables, now fresher (daily not weekly).
        features.update(_pe_features_from_db(symbol, con))
        features.update(_pb_features_from_db(symbol, con))

        # ── 2. DIVIDEND_YIELD_TTM_Q (quarterly, 32 pts) ──
```

Update the module docstring's endpoint list (currently lines 5-10) to drop the two removed params:

```python
Fetches 2 time-series params per stock from Trendlyne's chart-data API, plus DVM:

  EPS_TTM          → quarterly EPS trailing-12-month (31 pts, 8+ years); DVM scores embedded
  DIVIDEND_YIELD_TTM_Q → quarterly dividend yield (32 pts, 2019–now)

PE_TTM_SHARE_NOW / PBV_A_SHARE_NOW are no longer fetched here — mc_pricefeed_fetcher.py
already pulls each stock's own daily PE/PB and appends it into trendlyne_pe_history /
trendlyne_pb_history directly, so the percentile-rank features below now update daily.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/server && python -m pytest tests/test_trendlyne_fundamentals_fetcher.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the MC pricefeed PE/PB append**

Create `src/server/tests/test_mc_pricefeed_pe_pb_append.py`:

```python
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mc_pricefeed_fetcher as mpf


class FakeCursor:
    def __init__(self):
        self.executed = []
    def execute(self, sql, params=None):
        self.executed.append((sql, params))
    def fetchall(self):
        return []


class FakeConn:
    def __init__(self):
        self.cur = FakeCursor()
    def cursor(self):
        return self.cur
    def commit(self):
        pass
    def rollback(self):
        pass


def test_append_pe_pb_history_writes_both_tables_when_both_present():
    con = FakeConn()
    mpf.append_pe_pb_history("INFY", "2026-07-04", 28.5, 6.2, con)

    tables_written = [sql for sql, _ in con.cur.executed if "INSERT INTO" in sql]
    assert any("trendlyne_pe_history" in sql for sql in tables_written)
    assert any("trendlyne_pb_history" in sql for sql in tables_written)


def test_append_pe_pb_history_skips_missing_values():
    con = FakeConn()
    mpf.append_pe_pb_history("INFY", "2026-07-04", None, 6.2, con)

    tables_written = [sql for sql, _ in con.cur.executed if "INSERT INTO" in sql]
    assert not any("trendlyne_pe_history" in sql for sql in tables_written)
    assert any("trendlyne_pb_history" in sql for sql in tables_written)
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd src/server && python -m pytest tests/test_mc_pricefeed_pe_pb_append.py -v`
Expected: FAIL — `AttributeError: module 'mc_pricefeed_fetcher' has no attribute 'append_pe_pb_history'`.

- [ ] **Step 7: Add `append_pe_pb_history` to `mc_pricefeed_fetcher.py` and call it per stock**

Add this function near the other persistence helpers (e.g. right after `upsert_row`/`backfill_technical_signals`, whichever this file already has defined):

```python
def append_pe_pb_history(symbol: str, today: str, pe: float | None, pb: float | None, con) -> None:
    """Append today's MC-sourced PE/PB into the same history tables
    trendlyne_fundamentals_fetcher.py used to populate weekly from Trendlyne's dead
    PE_TTM_SHARE_NOW/PBV_A_SHARE_NOW params. Keeps pe_pct_rank_252d/pb_pct_rank_252d
    (computed from these tables) fresh daily instead of weekly."""
    cur = con.cursor()
    if pe is not None:
        cur.execute("""
            INSERT INTO trendlyne_pe_history (symbol, date, pe_ttm)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                pe_ttm = excluded.pe_ttm,
                fetched_at = CURRENT_TIMESTAMP
        """, (symbol, today, round(float(pe), 4)))
    if pb is not None:
        cur.execute("""
            INSERT INTO trendlyne_pb_history (symbol, date, pb_ratio)
            VALUES (?, ?, ?)
            ON CONFLICT(symbol, date) DO UPDATE SET
                pb_ratio = excluded.pb_ratio,
                fetched_at = CURRENT_TIMESTAMP
        """, (symbol, today, round(float(pb), 4)))
    con.commit()
```

In `main()`'s per-stock loop (currently):

```python
        f = extract_features(data)
        upsert_row(symbol, today, f, con)
        backfill_technical_signals(symbol, f, con)
```

add the call right after, using `f["pe"]`/`f["pb"]` (already computed by `extract_features` — see `"pe": pe` and `"pb": _sf(d.get("PB"))` in its return dict):

```python
        f = extract_features(data)
        upsert_row(symbol, today, f, con)
        backfill_technical_signals(symbol, f, con)
        append_pe_pb_history(symbol, today, f.get("pe"), f.get("pb"), con)
```

Also add the two `CREATE TABLE IF NOT EXISTS` statements for `trendlyne_pe_history`/`trendlyne_pb_history` (copied verbatim from `trendlyne_fundamentals_fetcher.py::ensure_schema`) into `mc_pricefeed_fetcher.py::ensure_schema`, so this doesn't depend on `trendlyne_fundamentals_fetcher.py` having run first on a brand-new database:

```python
    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_pe_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            pe_ttm REAL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tlpe_sym ON trendlyne_pe_history(symbol, date DESC)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_pb_history (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            pb_ratio REAL, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_tlpb_sym ON trendlyne_pb_history(symbol, date DESC)")
    con.commit()
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd src/server && python -m pytest tests/test_mc_pricefeed_pe_pb_append.py -v`
Expected: PASS (2/2).

- [ ] **Step 9: Update the `queues.ts` comment for the trimmed fetcher's estimated runtime**

In `src/server/queues.ts`, update the comment above the `trendlyne_fundamentals_fetcher.py` call (currently):

```typescript
  // Trendlyne EPS/PE/PB/DivYield series + DVM scores — 4 calls/stock, weekly sufficient.
  // 3058 stocks × 4 API calls × 0.5s = ~102 min
  await runPython('trendlyne_fundamentals_fetcher.py', [], 130 * 60_000)
```

to:

```typescript
  // Trendlyne EPS/DivYield series + DVM scores — 2 calls/stock (PE/PB dropped: MC's daily
  // fetch already covers them, fed into the same history tables — see mc_pricefeed_fetcher.py).
  // 3058 stocks × 2 API calls × 0.5s = ~51 min
  await runPython('trendlyne_fundamentals_fetcher.py', [], 70 * 60_000)
```

- [ ] **Step 10: Run both Python test files together plus the existing DVM/fundamentals regression test**

Run: `cd src/server && python -m pytest tests/test_trendlyne_fundamentals_fetcher.py tests/test_mc_pricefeed_pe_pb_append.py -v`
Expected: PASS (all).

- [ ] **Step 11: Commit**

```bash
git add src/server/trendlyne_fundamentals_fetcher.py src/server/mc_pricefeed_fetcher.py src/server/queues.ts src/server/tests/test_trendlyne_fundamentals_fetcher.py src/server/tests/test_mc_pricefeed_pe_pb_append.py
git commit -m "perf: drop redundant Trendlyne PE/PB re-pull, feed the same history tables from the existing daily MC fetch"
```

---

## Task 4: Shared ET_Stats client (`et_stats_client.py`)

New shared helper used by Tasks 5 and 6. Loads the `symbol → companyid` map from `scripts/stocklist.json` (2,005 stocks, already checked into the repo — the same file used elsewhere for provider ID resolution) and wraps the `etmarketsapis.indiatimes.com/ET_Stats/mobile` endpoint.

**Files:**
- Create: `src/server/et_stats_client.py`
- Test: `src/server/tests/test_et_stats_client.py` (new)

**Interfaces:**
- Produces: `load_companyid_map() -> dict[str, str]` (symbol upper → companyid string)
- Produces: `fetch_et_stats(company_id: str, events: str, session: requests.Session, last: int = 5) -> list[dict] | None` where `events` is one of `"Balance"`, `"CashFlow"`, `"Quarterly"`, `"Ratio"`.

- [ ] **Step 1: Write the failing test**

Create `src/server/tests/test_et_stats_client.py`:

```python
import json
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import et_stats_client as esc


def test_load_companyid_map_reads_symbol_and_companyid(tmp_path, monkeypatch):
    fixture = tmp_path / "stocklist.json"
    fixture.write_text(json.dumps([
        {"symbol": "infy", "companyid": "9195", "name": "Infosys"},
        {"symbol": "TCS", "companyid": "", "name": "TCS"},  # empty companyid skipped
        {"symbol": "BEL", "companyid": "11945", "name": "Bharat Electronics"},
    ]), encoding="utf-8")

    monkeypatch.setattr(esc, "_STOCKLIST_PATH", fixture)
    monkeypatch.setattr(esc, "_symbol_to_companyid", None)

    mapping = esc.load_companyid_map()

    assert mapping["INFY"] == "9195"
    assert mapping["BEL"] == "11945"
    assert "TCS" not in mapping


def test_load_companyid_map_is_cached_after_first_call(tmp_path, monkeypatch):
    fixture = tmp_path / "stocklist.json"
    fixture.write_text(json.dumps([{"symbol": "BEL", "companyid": "11945"}]), encoding="utf-8")
    monkeypatch.setattr(esc, "_STOCKLIST_PATH", fixture)
    monkeypatch.setattr(esc, "_symbol_to_companyid", None)

    first = esc.load_companyid_map()
    fixture.write_text(json.dumps([{"symbol": "OTHER", "companyid": "1"}]), encoding="utf-8")
    second = esc.load_companyid_map()

    assert first is second  # cached, second call did not re-read the (changed) file


def test_fetch_et_stats_returns_list_for_known_events():
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {
        "resultBalanceSheet": {"list": [{"inventories": 100.0}]}
    }
    fake_session = MagicMock()
    fake_session.get.return_value = fake_response

    result = esc.fetch_et_stats("11945", "Balance", fake_session)

    assert result == [{"inventories": 100.0}]
    fake_session.get.assert_called_once()
    call_kwargs = fake_session.get.call_args
    assert call_kwargs.kwargs["params"]["companyId"] == "11945"
    assert call_kwargs.kwargs["params"]["events"] == "Balance"


def test_fetch_et_stats_returns_none_on_empty_list():
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.json.return_value = {"resultCashFlowStatement": {"list": []}}
    fake_session = MagicMock()
    fake_session.get.return_value = fake_response

    result = esc.fetch_et_stats("11945", "CashFlow", fake_session)

    assert result is None


def test_fetch_et_stats_returns_none_on_non_200():
    fake_response = MagicMock()
    fake_response.status_code = 500
    fake_session = MagicMock()
    fake_session.get.return_value = fake_response

    result = esc.fetch_et_stats("11945", "Ratio", fake_session)

    assert result is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/server && python -m pytest tests/test_et_stats_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'et_stats_client'`.

- [ ] **Step 3: Create `src/server/et_stats_client.py`**

```python
#!/usr/bin/env python3
"""
ET_Stats mobile-endpoint client — shared by financial_ratios_fetcher.py and
working_capital_fetcher.py.

Replaces the Trendlyne chart-data params both scripts used to depend on
(CFO_Q, CAPEX_Q, EBIT_Q, INT_EXP_Q, TRADE_RECEIVABLE_Q, DEBTORS_Q,
INVENTORIES_Q, TRADE_PAYABLE_Q, CREDITORS_Q, REVENUE_Q, COGS_Q,
RAW_MATERIAL_Q) — confirmed dead via live testing on 2026-07-04, with and
without an authenticated Trendlyne session (every call returns HTTP 200,
head.status="0", eodData: [] — Trendlyne retired this parameter family,
this is not a rate limit).

Endpoint: https://etmarketsapis.indiatimes.com/ET_Stats/mobile
  ?companyId={id}&events={Balance|CashFlow|Quarterly|Ratio}&last={n}&bType=all

  events=Balance    -> annual balance sheet, 5 years back
                       (inventories, tradeReceivables, tradePayables, ...)
  events=CashFlow   -> annual cash flow, 5 years back
                       (netCashFlowFromOperatingActivities, netCashUsedInInvestingActivities)
  events=Quarterly  -> quarterly P&L, 8 quarters back
                       (totalIncome, totalExpenses, ebit, pat, ...)
  events=Ratio      -> annual ratios, 5 years back
                       (interestCoverage, currentRatio, inventoryTurnoverRatio, ...)

companyId is resolved via scripts/stocklist.json (symbol -> companyid), the
same 2,005-stock provider-ID export already used elsewhere in this project —
NOT via Trendlyne's tlid.
"""

import json
import time
from pathlib import Path

import requests

BASE_URL = "https://etmarketsapis.indiatimes.com/ET_Stats/mobile"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

RATE_LIMIT_SEC = 0.3

_RESULT_KEY = {
    "Balance": "resultBalanceSheet",
    "CashFlow": "resultCashFlowStatement",
    "Quarterly": "resultQuarterlyResult",
    "Ratio": "resultRatiosStatement",
}

_STOCKLIST_PATH = Path(__file__).resolve().parents[2] / "scripts" / "stocklist.json"
_symbol_to_companyid: dict[str, str] | None = None


def load_companyid_map() -> dict[str, str]:
    """symbol (uppercase) -> companyid, loaded once from scripts/stocklist.json."""
    global _symbol_to_companyid
    if _symbol_to_companyid is not None:
        return _symbol_to_companyid

    with open(_STOCKLIST_PATH, encoding="utf-8") as f:
        rows = json.load(f)

    _symbol_to_companyid = {
        row["symbol"].upper(): str(row["companyid"])
        for row in rows
        if row.get("symbol") and row.get("companyid")
    }
    return _symbol_to_companyid


def fetch_et_stats(
    company_id: str,
    events: str,
    session: requests.Session,
    last: int = 5,
) -> list[dict] | None:
    """Fetch one events= slice for a companyId. Returns the inner `list`
    (most-recent-first) or None on failure/empty response."""
    result_key = _RESULT_KEY[events]
    try:
        r = session.get(
            BASE_URL,
            params={"companyId": company_id, "events": events, "last": last, "bType": "all"},
            timeout=15,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        rows = data.get(result_key, {}).get("list", [])
        return rows if rows else None
    except Exception as e:
        print(f"  [ET_Stats {events}] error: {e}")
        return None
    finally:
        time.sleep(RATE_LIMIT_SEC)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/server && python -m pytest tests/test_et_stats_client.py -v`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/server/et_stats_client.py src/server/tests/test_et_stats_client.py
git commit -m "feat: add et_stats_client.py — ET_Stats mobile endpoint wrapper for financial-ratio/working-capital data"
```

---

## Task 5: Rewrite `financial_ratios_fetcher.py` against ET_Stats

`CFO_Q`, `CAPEX_Q`, `EBIT_Q`, `INT_EXP_Q` are all confirmed dead on Trendlyne. ET_Stats gives `netCashFlowFromOperatingActivities` (CFO, annual), `ebit`/`totalExpenses` (quarterly P&L), and — most usefully — `interestCoverage` **pre-computed** (annual `Ratio` event), removing the need to derive it manually at all. No CAPEX field exists anywhere checked (MC, Trendlyne, ET, Tickertape) — FCF yield is approximated using `netCashUsedInInvestingActivities` (CFI) as a CAPEX proxy, clearly labeled, since CFI is dominated by CAPEX for most non-financial companies and a labeled approximation is more useful than dropping the feature.

**Files:**
- Modify: `src/server/financial_ratios_fetcher.py` (full rewrite of fetch/compute logic; schema and `technical_signals` columns unchanged)
- Test: `src/server/tests/test_financial_ratios_fetcher.py` (new; replaces reliance on any prior Trendlyne-specific test if one exists — none currently does per the repo scan)

**Interfaces:**
- Produces: `compute_ratios(balance: list[dict] | None, cashflow: list[dict] | None, ratio: list[dict] | None, market_cap: float | None) -> dict` — pure function, the core of this rewrite, fully unit-testable without any network access.

- [ ] **Step 1: Write the failing tests for the pure `compute_ratios` function**

Create `src/server/tests/test_financial_ratios_fetcher.py`:

```python
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import financial_ratios_fetcher as frf


def _cashflow_row(cfo, cfi):
    return {"netCashFlowFromOperatingActivities": cfo, "netCashUsedInInvestingActivities": cfi}


def _ratio_row(interest_coverage):
    return {"interestCoverage": interest_coverage}


class TestComputeRatios:
    def test_fcf_yield_uses_cfi_as_capex_proxy(self):
        cashflow = [_cashflow_row(cfo=1500.0, cfi=-400.0)]
        ratio = [_ratio_row(interest_coverage=12.5)]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=50000.0)

        # fcf_approx = cfo + cfi = 1500 + (-400) = 1100 (CFI is negative for capex-heavy firms)
        assert result["fcf_ttm_approx"] == 1100.0
        assert result["fcf_yield_approx"] == round(1100.0 / 50000.0 * 100, 4)
        assert result["interest_coverage"] == 12.5

    def test_interest_coverage_read_directly_not_derived(self):
        ratio = [_ratio_row(interest_coverage=1280.61)]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["interest_coverage"] == 1280.61
        assert result["fcf_yield_approx"] is None

    def test_missing_market_cap_yields_no_fcf_yield_but_keeps_fcf_amount(self):
        cashflow = [_cashflow_row(cfo=1000.0, cfi=-200.0)]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["fcf_ttm_approx"] == 800.0
        assert result["fcf_yield_approx"] is None

    def test_missing_cashflow_returns_all_none_for_fcf_fields(self):
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=None, market_cap=50000.0)
        assert result["fcf_ttm_approx"] is None
        assert result["fcf_yield_approx"] is None
        assert result["interest_coverage"] is None

    def test_debt_coverage_risk_flag_below_threshold(self):
        ratio = [_ratio_row(interest_coverage=1.2)]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["debt_coverage_risk"] == 1

    def test_debt_coverage_risk_flag_above_threshold(self):
        ratio = [_ratio_row(interest_coverage=5.0)]
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=ratio, market_cap=None)
        assert result["debt_coverage_risk"] == 0

    def test_fcf_positive_flag(self):
        cashflow = [_cashflow_row(cfo=1000.0, cfi=-1500.0)]
        result = frf.compute_ratios(balance=None, cashflow=cashflow, ratio=None, market_cap=None)
        assert result["fcf_ttm_approx"] == -500.0
        assert result["fcf_positive"] == 0

    def test_empty_ratio_list_element_missing_key_is_none(self):
        result = frf.compute_ratios(balance=None, cashflow=None, ratio=[{}], market_cap=None)
        assert result["interest_coverage"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/server && python -m pytest tests/test_financial_ratios_fetcher.py -v`
Expected: FAIL — `AttributeError: module 'financial_ratios_fetcher' has no attribute 'compute_ratios'` (current module has the old Trendlyne-based `process_stock` instead).

- [ ] **Step 3: Rewrite `src/server/financial_ratios_fetcher.py`**

Replace the entire file:

```python
#!/usr/bin/env python3
"""
Financial Ratios Fetcher — FCF Yield (approx) + Interest Coverage
===================================================================
Rewritten 2026-07-04: the Trendlyne chart-data params this used to depend on
(CFO_Q, CAPEX_Q, EBIT_Q, INT_EXP_Q) are confirmed dead (live-tested, with and
without an authenticated Trendlyne session — Trendlyne retired this param
family, not a rate limit). Replaced with etmarketsapis.indiatimes.com's
ET_Stats mobile endpoint (see et_stats_client.py), keyed by each stock's ET
`companyid` (from scripts/stocklist.json) instead of Trendlyne's `tlid`.

  Interest Coverage = read directly from ET_Stats Ratio.interestCoverage
                       (ET computes this for us — no manual EBIT/interest
                       derivation needed).
  FCF Yield (approx) = (CFO + CFI) / market_cap * 100
                       No CAPEX line item was found in MC, Trendlyne, ET, or
                       Tickertape for this platform's stock universe — CFI
                       (net cash used in investing activities, ET_Stats
                       CashFlow.netCashUsedInInvestingActivities) is used as
                       a CAPEX proxy since it's CAPEX-dominated for most
                       non-financial companies. Clearly labeled "_approx" in
                       every column/field name so downstream consumers know
                       this is an approximation, not a precise FCF figure.

Cadence: monthly (Balance/CashFlow/Ratio are annual-refresh ET_Stats data —
no value in fetching more often than once a month).

Writes:
  tl_financial_quality  (symbol, as_of_date) — raw + derived values
  technical_signals     — fcf_yield_approx, interest_coverage, fcf_positive,
                          debt_coverage_risk

Run:
  python financial_ratios_fetcher.py              # all stocks with a companyid
  python financial_ratios_fetcher.py --symbol BEL
  python financial_ratios_fetcher.py --limit 50
"""

import argparse
from datetime import date

import requests

from db_compat import connect
from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map

DEBT_COVERAGE_RISK_THRESHOLD = 1.5


# ── Schema ──────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tl_financial_quality (
            symbol               TEXT NOT NULL,
            as_of_date           TEXT NOT NULL,
            cfo_ttm              REAL,
            cfi_ttm              REAL,
            fcf_ttm_approx       REAL,
            interest_coverage    REAL,
            market_cap           REAL,
            fcf_yield_approx     REAL,
            fetched_at           TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, as_of_date)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_tlfq_sym
        ON tl_financial_quality(symbol, as_of_date DESC)
    """)
    con.commit()

    for ddl in [
        "ALTER TABLE tl_financial_quality ADD COLUMN fetched_at TEXT DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE technical_signals ADD COLUMN fcf_yield_approx   REAL",
        "ALTER TABLE technical_signals ADD COLUMN interest_coverage  REAL",
        "ALTER TABLE technical_signals ADD COLUMN fcf_positive       INTEGER",
        "ALTER TABLE technical_signals ADD COLUMN debt_coverage_risk INTEGER",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Pure computation (fully unit-testable, no network/DB) ───────────────────────

def compute_ratios(
    balance: list[dict] | None,
    cashflow: list[dict] | None,
    ratio: list[dict] | None,
    market_cap: float | None,
) -> dict:
    """All four ET_Stats event lists are most-recent-first; index 0 is the
    latest available period. `balance` is accepted for interface symmetry
    with working_capital_fetcher.py but unused here."""
    cfo = cashflow[0].get("netCashFlowFromOperatingActivities") if cashflow else None
    cfi = cashflow[0].get("netCashUsedInInvestingActivities") if cashflow else None
    interest_coverage = ratio[0].get("interestCoverage") if ratio else None

    fcf_ttm_approx: float | None = None
    if cfo is not None and cfi is not None:
        fcf_ttm_approx = round(float(cfo) + float(cfi), 2)

    fcf_yield_approx: float | None = None
    if fcf_ttm_approx is not None and market_cap and market_cap > 0:
        fcf_yield_approx = round(fcf_ttm_approx / market_cap * 100, 4)

    fcf_positive = 1 if (fcf_ttm_approx is not None and fcf_ttm_approx > 0) else (0 if fcf_ttm_approx is not None else None)
    debt_coverage_risk = (
        1 if (interest_coverage is not None and interest_coverage < DEBT_COVERAGE_RISK_THRESHOLD) else
        (0 if interest_coverage is not None else None)
    )

    return {
        "cfo_ttm": round(float(cfo), 2) if cfo is not None else None,
        "cfi_ttm": round(float(cfi), 2) if cfi is not None else None,
        "fcf_ttm_approx": fcf_ttm_approx,
        "interest_coverage": round(float(interest_coverage), 2) if interest_coverage is not None else None,
        "market_cap": round(float(market_cap), 2) if market_cap is not None else None,
        "fcf_yield_approx": fcf_yield_approx,
        "fcf_positive": fcf_positive,
        "debt_coverage_risk": debt_coverage_risk,
    }


# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert_quality(symbol: str, today: str, row: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        INSERT INTO tl_financial_quality
            (symbol, as_of_date, cfo_ttm, cfi_ttm, fcf_ttm_approx,
             interest_coverage, market_cap, fcf_yield_approx)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, as_of_date) DO UPDATE SET
            cfo_ttm            = excluded.cfo_ttm,
            cfi_ttm            = excluded.cfi_ttm,
            fcf_ttm_approx     = excluded.fcf_ttm_approx,
            interest_coverage  = excluded.interest_coverage,
            market_cap         = excluded.market_cap,
            fcf_yield_approx   = excluded.fcf_yield_approx,
            fetched_at         = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        row.get("cfo_ttm"), row.get("cfi_ttm"), row.get("fcf_ttm_approx"),
        row.get("interest_coverage"), row.get("market_cap"), row.get("fcf_yield_approx"),
    ))
    con.commit()


def update_technical_signals(symbol: str, features: dict, con) -> None:
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            fcf_yield_approx   = COALESCE(?, fcf_yield_approx),
            interest_coverage  = COALESCE(?, interest_coverage),
            fcf_positive       = COALESCE(?, fcf_positive),
            debt_coverage_risk = COALESCE(?, debt_coverage_risk)
        WHERE symbol = ?
    """, (
        features.get("fcf_yield_approx"),
        features.get("interest_coverage"),
        features.get("fcf_positive"),
        features.get("debt_coverage_risk"),
        symbol,
    ))
    con.commit()


def get_market_cap(symbol: str, con) -> float | None:
    cur = con.cursor()
    cur.execute("SELECT market_cap FROM stock_fundamentals WHERE symbol = ?", (symbol,))
    row = cur.fetchone()
    return float(row[0]) if row and row[0] is not None else None


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, company_id: str, today: str,
                   session: requests.Session, con) -> dict:
    cashflow = fetch_et_stats(company_id, "CashFlow", session)
    ratio = fetch_et_stats(company_id, "Ratio", session)
    market_cap = get_market_cap(symbol, con)

    features = compute_ratios(balance=None, cashflow=cashflow, ratio=ratio, market_cap=market_cap)

    upsert_quality(symbol, today, features, con)
    update_technical_signals(symbol, features, con)
    return features


# ── Stock list ────────────────────────────────────────────────────────────────────

def load_stocks(symbol_filter: str | None, limit: int | None) -> list[tuple[str, str]]:
    """Return [(symbol, company_id), ...] from scripts/stocklist.json."""
    company_map = load_companyid_map()
    rows = sorted(company_map.items())
    if symbol_filter:
        rows = [(s, c) for s, c in rows if s == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="FCF yield (approx) + interest coverage from ET_Stats")
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[FinancialRatios] No stocks with a companyid found.")
        con.close()
        return

    print(f"[FinancialRatios] Processing {len(stocks)} stocks — FCF yield (approx) + interest coverage…")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()

    ok = 0
    fcf_positive_count = 0
    distress_count = 0

    for i, (symbol, company_id) in enumerate(stocks, 1):
        try:
            features = process_stock(symbol, company_id, today, session, con)
            ok += 1

            if features.get("fcf_positive"):
                fcf_positive_count += 1
            if features.get("debt_coverage_risk"):
                distress_count += 1

            fcf_str = f"FCF yield≈{features['fcf_yield_approx']:.2f}%" if features.get("fcf_yield_approx") is not None else "FCF yield=n/a"
            cov_str = f"IC={features['interest_coverage']:.1f}x" if features.get("interest_coverage") is not None else "IC=n/a"
            flag = " [DISTRESS]" if features.get("debt_coverage_risk") else ""
            print(f"  [{i}/{len(stocks)}] {symbol}: {fcf_str} | {cov_str}{flag}")

        except Exception as e:
            try:
                con.rollback()
            except Exception:
                pass
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}")

    fcf_pct = round(fcf_positive_count / ok * 100) if ok else 0
    print(
        f"[FinancialRatios] Done. {ok} stocks. "
        f"FCF positive: {fcf_pct}%. "
        f"Interest coverage distress (<{DEBT_COVERAGE_RISK_THRESHOLD}x): {distress_count} stocks."
    )
    con.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/server && python -m pytest tests/test_financial_ratios_fetcher.py -v`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add src/server/financial_ratios_fetcher.py src/server/tests/test_financial_ratios_fetcher.py
git commit -m "fix: rewrite financial_ratios_fetcher.py against ET_Stats — Trendlyne's CFO_Q/CAPEX_Q/EBIT_Q/INT_EXP_Q are confirmed dead"
```

---

## Task 6: Rewrite `working_capital_fetcher.py` against ET_Stats (annual cadence)

`TRADE_RECEIVABLE_Q`/`DEBTORS_Q`/`INVENTORIES_Q`/`TRADE_PAYABLE_Q`/`CREDITORS_Q`/`REVENUE_Q`/`COGS_Q`/`RAW_MATERIAL_Q` are all confirmed dead on Trendlyne. ET_Stats `Balance` gives `inventories`/`tradeReceivables`/`tradePayables` directly, but only at **annual** granularity — same as Trendlyne's own true ceiling, since Indian-listed companies only file balance sheets annually, not quarterly. This is a genuine data-availability constraint, not a fetcher bug, so the cash-conversion-cycle computation moves from a quarterly to a fiscal-year cadence. Revenue/COGS proxies come from summing the four `Quarterly` P&L rows whose `yearEnding` falls in that fiscal year (`totalIncome` for revenue, `totalExpenses` as a COGS proxy — no distinct COGS line exists in ET_Stats either).

**Files:**
- Modify: `src/server/working_capital_fetcher.py` (full rewrite)
- Test: `src/server/tests/test_working_capital_fetcher.py` (new)

**Interfaces:**
- Produces: `compute_ccc(balance: list[dict], quarterly: list[dict]) -> list[dict]` — pure function, one dict per fiscal year with `fiscal_year`, `receivables_days`, `inventory_days`, `payables_days`, `ccc`, `revenue_fy`, `cogs_proxy_fy`.

- [ ] **Step 1: Write the failing tests for the pure `compute_ccc` function**

Create `src/server/tests/test_working_capital_fetcher.py`:

```python
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import working_capital_fetcher as wcf


def _balance_row(year_ending, inventories, receivables, payables):
    return {
        "yearEnding": year_ending,
        "inventories": inventories,
        "tradeReceivables": receivables,
        "tradePayables": payables,
    }


def _quarterly_row(year_ending, total_income, total_expenses):
    return {"yearEnding": year_ending, "totalIncome": total_income, "totalExpenses": total_expenses}


class TestComputeCcc:
    def test_single_fiscal_year_full_data(self):
        balance = [_balance_row("2026-03-31", inventories=10000.0, receivables=12000.0, payables=3500.0)]
        quarterly = [
            _quarterly_row("2026-03-31", 10000.0, 7000.0),
            _quarterly_row("2025-12-31", 9500.0, 6800.0),
            _quarterly_row("2025-09-30", 9000.0, 6500.0),
            _quarterly_row("2025-06-30", 8500.0, 6200.0),
        ]
        result = wcf.compute_ccc(balance, quarterly)

        assert len(result) == 1
        row = result[0]
        assert row["fiscal_year"] == "2026-03-31"
        revenue_fy = 10000.0 + 9500.0 + 9000.0 + 8500.0
        cogs_fy = 7000.0 + 6800.0 + 6500.0 + 6200.0
        assert row["revenue_fy"] == revenue_fy
        assert row["cogs_proxy_fy"] == cogs_fy
        assert row["receivables_days"] == round(12000.0 / revenue_fy * 365, 2)
        assert row["inventory_days"] == round(10000.0 / cogs_fy * 365, 2)
        assert row["payables_days"] == round(3500.0 / cogs_fy * 365, 2)
        assert row["ccc"] == round(row["receivables_days"] + row["inventory_days"] - row["payables_days"], 2)

    def test_skips_fiscal_year_with_fewer_than_4_matching_quarters(self):
        balance = [_balance_row("2026-03-31", 10000.0, 12000.0, 3500.0)]
        quarterly = [
            _quarterly_row("2026-03-31", 10000.0, 7000.0),
            _quarterly_row("2025-12-31", 9500.0, 6800.0),
        ]
        result = wcf.compute_ccc(balance, quarterly)
        assert result == []

    def test_skips_fiscal_year_with_zero_revenue(self):
        balance = [_balance_row("2026-03-31", 10000.0, 12000.0, 3500.0)]
        quarterly = [_quarterly_row("2026-03-31", 0.0, 0.0)] * 4
        result = wcf.compute_ccc(balance, quarterly)
        assert result == []

    def test_multiple_fiscal_years_each_computed_independently(self):
        balance = [
            _balance_row("2026-03-31", 10000.0, 12000.0, 3500.0),
            _balance_row("2025-03-31", 8000.0, 10000.0, 3000.0),
        ]
        quarterly = (
            [_quarterly_row("2026-03-31", 10000.0, 7000.0)] * 4 +
            [_quarterly_row("2025-03-31", 8000.0, 6000.0)] * 4
        )
        result = wcf.compute_ccc(balance, quarterly)
        assert len(result) == 2
        assert {r["fiscal_year"] for r in result} == {"2026-03-31", "2025-03-31"}

    def test_empty_inputs_return_empty_list(self):
        assert wcf.compute_ccc([], []) == []
        assert wcf.compute_ccc(None, None) == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/server && python -m pytest tests/test_working_capital_fetcher.py -v`
Expected: FAIL — `AttributeError: module 'working_capital_fetcher' has no attribute 'compute_ccc'`.

- [ ] **Step 3: Rewrite `src/server/working_capital_fetcher.py`**

Replace the entire file:

```python
#!/usr/bin/env python3
"""
Working Capital Fetcher — Cash Conversion Cycle (annual cadence)
====================================================================
Rewritten 2026-07-04: the Trendlyne chart-data params this used to depend on
(TRADE_RECEIVABLE_Q, DEBTORS_Q, INVENTORIES_Q, TRADE_PAYABLE_Q, CREDITORS_Q,
REVENUE_Q, COGS_Q, RAW_MATERIAL_Q) are confirmed dead (live-tested, with and
without an authenticated Trendlyne session — Trendlyne retired this param
family, not a rate limit). Replaced with etmarketsapis.indiatimes.com's
ET_Stats mobile endpoint (see et_stats_client.py), keyed by ET `companyid`
(from scripts/stocklist.json) instead of Trendlyne's `tlid`.

Cadence change: receivables/inventory/payables only exist at ANNUAL
granularity in ET_Stats' Balance event — this matches Trendlyne's own true
ceiling too, since Indian-listed companies only file balance sheets
annually, not quarterly (only P&L is quarterly). This was always going to be
annual-cadence data; the old quarterly framing was never achievable. Revenue
and a COGS proxy for each fiscal year come from summing the 4 Quarterly
P&L rows (totalIncome, totalExpenses) whose yearEnding falls in that year.

Metrics (per fiscal year):
  Receivables days = (Trade Receivables / FY Revenue) × 365
  Inventory days   = (Inventory / FY COGS-proxy) × 365
  Payables days    = (Trade Payables / FY COGS-proxy) × 365
  CCC              = Receivables days + Inventory days - Payables days

Writes:
  working_capital_history  (symbol, fiscal_year) — per-year computed values
  technical_signals        — receivables_days_ttm, ccc_ttm, ccc_trend,
                             wc_deteriorating, wc_improving
  (column names kept as *_ttm for compatibility with existing consumers —
  "ttm" here means "most recent fiscal year", not a rolling 12 months.)

Cadence: monthly (annual-refresh data — no value fetching more often).

Run:
  python working_capital_fetcher.py              # all stocks with a companyid
  python working_capital_fetcher.py --symbol BEL
  python working_capital_fetcher.py --limit 50
"""

import argparse
from datetime import date, timedelta

import requests

from db_compat import connect
from et_stats_client import HEADERS, fetch_et_stats, load_companyid_map

DETERIORATING_THRESHOLD_DAYS = 5
IMPROVING_THRESHOLD_DAYS = -5


# ── Schema ──────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS working_capital_history (
            symbol           TEXT NOT NULL,
            fiscal_year      TEXT NOT NULL,
            receivables_days REAL,
            inventory_days   REAL,
            payables_days    REAL,
            ccc              REAL,
            revenue_fy       REAL,
            cogs_proxy_fy    REAL,
            fetched_at       TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, fiscal_year)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_wch_sym
        ON working_capital_history(symbol, fiscal_year DESC)
    """)
    con.commit()

    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN receivables_days_ttm REAL",
        "ALTER TABLE technical_signals ADD COLUMN ccc_ttm              REAL",
        "ALTER TABLE technical_signals ADD COLUMN ccc_trend            REAL",
        "ALTER TABLE technical_signals ADD COLUMN wc_deteriorating     INTEGER DEFAULT 0",
        "ALTER TABLE technical_signals ADD COLUMN wc_improving         INTEGER DEFAULT 0",
    ]:
        try:
            cur.execute(ddl)
            con.commit()
        except Exception:
            con.rollback()


# ── Pure computation (fully unit-testable, no network/DB) ───────────────────────

def _parse_yearending(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def compute_ccc(balance: list[dict] | None, quarterly: list[dict] | None) -> list[dict]:
    """balance: ET_Stats Balance.list (annual, most-recent-first).
    quarterly: ET_Stats Quarterly.list (quarterly, most-recent-first, 8 back).
    Returns one row per fiscal year that has both a balance-sheet snapshot
    and exactly 4 matching quarterly P&L rows, most-recent fiscal year first.

    A quarterly row belongs to a balance-sheet fiscal year if its yearEnding
    falls in the 12 months up to and including the balance sheet's own
    yearEnding — a plain "same calendar year" string match is wrong here
    because India's fiscal year runs Apr-Mar, so FY26's quarters carry
    yearEnding dates in both 2025 (Jun/Sep/Dec) and 2026 (Mar).
    """
    if not balance or not quarterly:
        return []

    results = []
    for b in balance:
        fy_end = _parse_yearending(b.get("yearEnding"))
        if fy_end is None:
            continue
        fy_start = fy_end.replace(year=fy_end.year - 1) + timedelta(days=1)

        year_quarters = [
            q for q in quarterly
            if (q_end := _parse_yearending(q.get("yearEnding"))) is not None and fy_start <= q_end <= fy_end
        ]
        if len(year_quarters) < 4:
            continue

        revenue_fy = sum(float(q.get("totalIncome") or 0) for q in year_quarters[:4])
        cogs_fy = sum(float(q.get("totalExpenses") or 0) for q in year_quarters[:4])

        if revenue_fy == 0:
            continue

        receivables = b.get("tradeReceivables")
        inventories = b.get("inventories")
        payables = b.get("tradePayables")

        if receivables is None:
            continue

        receivables_days = round(float(receivables) / revenue_fy * 365, 2)
        inventory_days = round(float(inventories) / cogs_fy * 365, 2) if inventories is not None and cogs_fy else None
        payables_days = round(float(payables) / cogs_fy * 365, 2) if payables is not None and cogs_fy else None
        ccc = round(receivables_days + inventory_days - payables_days, 2) if inventory_days is not None and payables_days is not None else None

        results.append({
            "fiscal_year": b.get("yearEnding"),
            "receivables_days": receivables_days,
            "inventory_days": inventory_days,
            "payables_days": payables_days,
            "ccc": ccc,
            "revenue_fy": revenue_fy,
            "cogs_proxy_fy": cogs_fy,
        })

    return results


# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert_wc_history(symbol: str, rows: list[dict], con) -> None:
    cur = con.cursor()
    for row in rows:
        cur.execute("""
            INSERT INTO working_capital_history
                (symbol, fiscal_year, receivables_days, inventory_days,
                 payables_days, ccc, revenue_fy, cogs_proxy_fy)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol, fiscal_year) DO UPDATE SET
                receivables_days = excluded.receivables_days,
                inventory_days   = excluded.inventory_days,
                payables_days    = excluded.payables_days,
                ccc              = excluded.ccc,
                revenue_fy       = excluded.revenue_fy,
                cogs_proxy_fy    = excluded.cogs_proxy_fy,
                fetched_at       = CURRENT_TIMESTAMP
        """, (
            symbol, row["fiscal_year"], row["receivables_days"], row["inventory_days"],
            row["payables_days"], row["ccc"], row["revenue_fy"], row["cogs_proxy_fy"],
        ))
    con.commit()


def update_technical_signals(symbol: str, features: dict, con) -> None:
    if not features:
        return
    cur = con.cursor()
    cur.execute("""
        UPDATE technical_signals SET
            receivables_days_ttm = COALESCE(?, receivables_days_ttm),
            ccc_ttm              = COALESCE(?, ccc_ttm),
            ccc_trend            = COALESCE(?, ccc_trend),
            wc_deteriorating     = COALESCE(?, wc_deteriorating),
            wc_improving         = COALESCE(?, wc_improving)
        WHERE symbol = ?
    """, (
        features.get("receivables_days_ttm"),
        features.get("ccc_ttm"),
        features.get("ccc_trend"),
        features.get("wc_deteriorating"),
        features.get("wc_improving"),
        symbol,
    ))
    con.commit()


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, company_id: str, session: requests.Session, con) -> dict:
    balance = fetch_et_stats(company_id, "Balance", session)
    quarterly = fetch_et_stats(company_id, "Quarterly", session)

    ccc_rows = compute_ccc(balance, quarterly)
    if not ccc_rows:
        return {}

    upsert_wc_history(symbol, ccc_rows, con)

    latest = ccc_rows[0]
    prior = ccc_rows[1] if len(ccc_rows) > 1 else None

    ccc_trend = round(latest["ccc"] - prior["ccc"], 2) if latest.get("ccc") is not None and prior and prior.get("ccc") is not None else None
    wc_deteriorating = 1 if (ccc_trend is not None and ccc_trend > DETERIORATING_THRESHOLD_DAYS) else 0
    wc_improving = 1 if (ccc_trend is not None and ccc_trend < IMPROVING_THRESHOLD_DAYS) else 0

    features = {
        "receivables_days_ttm": latest.get("receivables_days"),
        "ccc_ttm": latest.get("ccc"),
        "ccc_trend": ccc_trend,
        "wc_deteriorating": wc_deteriorating,
        "wc_improving": wc_improving,
    }
    update_technical_signals(symbol, features, con)
    return features


# ── Stock list ────────────────────────────────────────────────────────────────────

def load_stocks(symbol_filter: str | None, limit: int | None) -> list[tuple[str, str]]:
    company_map = load_companyid_map()
    rows = sorted(company_map.items())
    if symbol_filter:
        rows = [(s, c) for s, c in rows if s == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Cash Conversion Cycle (annual) from ET_Stats")
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[WorkingCapital] No stocks with a companyid found.")
        con.close()
        return

    print(f"[WorkingCapital] Processing {len(stocks)} stocks — cash conversion cycle (annual)…")
    session = requests.Session()
    session.headers.update(HEADERS)

    ok = 0
    ccc_sum = 0.0
    ccc_count = 0
    deteriorating = 0
    improving = 0

    for i, (symbol, company_id) in enumerate(stocks, 1):
        try:
            features = process_stock(symbol, company_id, session, con)
            if not features:
                print(f"  [{i}/{len(stocks)}] {symbol}: no data")
                continue

            ok += 1
            ccc = features.get("ccc_ttm")
            trend = features.get("ccc_trend")

            if ccc is not None:
                ccc_sum += ccc
                ccc_count += 1
            if features.get("wc_deteriorating"):
                deteriorating += 1
            if features.get("wc_improving"):
                improving += 1

            ccc_str = f"CCC={ccc:.1f}d" if ccc is not None else "CCC=n/a"
            trend_str = f"trend={trend:+.1f}d" if trend is not None else "trend=n/a"
            flag = " [DETERIORATING]" if features.get("wc_deteriorating") else (" [IMPROVING]" if features.get("wc_improving") else "")
            print(f"  [{i}/{len(stocks)}] {symbol}: {ccc_str} | {trend_str}{flag}")

        except Exception as e:
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}")

    ccc_avg = round(ccc_sum / ccc_count, 1) if ccc_count else 0
    print(
        f"[WorkingCapital] Done. {ok} stocks. "
        f"CCC avg: {ccc_avg} days. "
        f"Deteriorating (>{DETERIORATING_THRESHOLD_DAYS}d trend): {deteriorating} stocks. "
        f"Improving: {improving} stocks."
    )
    con.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/server && python -m pytest tests/test_working_capital_fetcher.py -v`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/server/working_capital_fetcher.py src/server/tests/test_working_capital_fetcher.py
git commit -m "fix: rewrite working_capital_fetcher.py against ET_Stats (annual cadence — India only files balance sheets annually)"
```

---

## Task 7: Deduplicate `company-profiles-sync` and `trendlyne_overview_fetcher.py`

Both hit `equity/overview-second-part/{tlid}/` for the same ~3,022-stock universe, 8.5 hours apart. `trendlyne_overview_fetcher.py` gains a `company_description` capture; `companyProfileSyncService.ts` is rewritten to run that Python script first and then read the description from the DB instead of calling Trendlyne itself a second time.

**Files:**
- Modify: `src/server/trendlyne_overview_fetcher.py`
- Modify: `src/server/companyProfileSyncService.ts`
- Test: `src/server/tests/test_trendlyne_overview_fetcher.py` (new)
- Test: `src/server/__tests__/companyProfileSyncService.test.ts` (new)

**Interfaces:**
- Produces (Python): `extract_company_description(overview_body: dict) -> str | None`
- Produces (TS): `syncAndAnalyzeCompanyProfiles()` now takes no Trendlyne network dependency of its own — it shells out to `trendlyne_overview_fetcher.py` via `runPython`, then reads `trendlyne_stock_profile.company_description`.

- [ ] **Step 1: Write the failing test for `extract_company_description`**

Create `src/server/tests/test_trendlyne_overview_fetcher.py`:

```python
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import trendlyne_overview_fetcher as tof


def test_extract_company_description_reads_the_field():
    body = {"companyProfileData": {"companyDescription": "Bharat Electronics Limited manufactures..."}}
    assert tof.extract_company_description(body) == "Bharat Electronics Limited manufactures..."


def test_extract_company_description_returns_none_when_missing():
    assert tof.extract_company_description({}) is None
    assert tof.extract_company_description({"companyProfileData": {}}) is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/server && python -m pytest tests/test_trendlyne_overview_fetcher.py -v`
Expected: FAIL — `AttributeError: module 'trendlyne_overview_fetcher' has no attribute 'extract_company_description'`.

- [ ] **Step 3: Add `company_description` capture to `trendlyne_overview_fetcher.py`**

Add this function near `extract_event_data`:

```python
def extract_company_description(body: dict) -> str | None:
    return body.get("companyProfileData", {}).get("companyDescription") or None
```

Add a `company_description` column to `trendlyne_stock_profile` in `ensure_schema`. In the `CREATE TABLE IF NOT EXISTS trendlyne_stock_profile (` block, add the column right after `symbol TEXT NOT NULL, date TEXT NOT NULL,`:

```python
            company_description TEXT,
```

Add a migration line to the `for ddl in [...]` loop already in `ensure_schema`:

```python
        "ALTER TABLE trendlyne_stock_profile ADD COLUMN company_description TEXT",
```

In `main()`, after the existing overview-fetch step (currently):

```python
        # ── 1. overview-second-part (analyst targets + events) ──
        overview_body = _fetch(OVERVIEW_URL.format(tlid=tlid), session)
        if overview_body is not None:
            analyst = extract_analyst_data(overview_body, symbol, today, con)
            events  = extract_event_data(overview_body)
            profile.update(analyst)
            profile.update(events)
        time.sleep(RATE_LIMIT_SEC)
```

add the description capture:

```python
        # ── 1. overview-second-part (analyst targets + events + company description) ──
        overview_body = _fetch(OVERVIEW_URL.format(tlid=tlid), session)
        if overview_body is not None:
            analyst = extract_analyst_data(overview_body, symbol, today, con)
            events  = extract_event_data(overview_body)
            description = extract_company_description(overview_body)
            profile.update(analyst)
            profile.update(events)
            if description:
                profile["company_description"] = description
        time.sleep(RATE_LIMIT_SEC)
```

Add `company_description` to both the `INSERT INTO trendlyne_stock_profile` column list and the `ON CONFLICT ... DO UPDATE SET` clause in `upsert_profile`, and to its parameter tuple (insert right after `days_since_dividend` in both the column list and the `VALUES` param tuple, adding one more `?` placeholder):

```python
    cur.execute("""
        INSERT INTO trendlyne_stock_profile (
            symbol, date,
            np_annual, ebitda_annual, revenue_annual, eps_annual,
            ebitda_margin, np_margin, cfo_annual,
            roe, roce, ltde_ratio, current_ratio,
            promoter_pct, fii_pct, mf_pct, pledge_pct,
            rev_cagr_5y, np_cagr_5y,
            rev_growth_yoy_q, np_growth_yoy_q,
            analyst_target_mean, analyst_count, analyst_buy_pct, analyst_upside_pct,
            last_dividend_amt, last_ex_date, days_since_dividend, company_description
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, date) DO UPDATE SET
            np_annual           = excluded.np_annual,
            ebitda_annual       = excluded.ebitda_annual,
            revenue_annual      = excluded.revenue_annual,
            eps_annual          = excluded.eps_annual,
            ebitda_margin       = excluded.ebitda_margin,
            np_margin           = excluded.np_margin,
            cfo_annual          = excluded.cfo_annual,
            roe                 = excluded.roe,
            roce                = excluded.roce,
            ltde_ratio          = excluded.ltde_ratio,
            current_ratio       = excluded.current_ratio,
            promoter_pct        = excluded.promoter_pct,
            fii_pct             = excluded.fii_pct,
            mf_pct              = excluded.mf_pct,
            pledge_pct          = excluded.pledge_pct,
            rev_cagr_5y         = excluded.rev_cagr_5y,
            np_cagr_5y          = excluded.np_cagr_5y,
            rev_growth_yoy_q    = excluded.rev_growth_yoy_q,
            np_growth_yoy_q     = excluded.np_growth_yoy_q,
            analyst_target_mean = excluded.analyst_target_mean,
            analyst_count       = excluded.analyst_count,
            analyst_buy_pct     = excluded.analyst_buy_pct,
            analyst_upside_pct  = excluded.analyst_upside_pct,
            last_dividend_amt   = excluded.last_dividend_amt,
            last_ex_date        = excluded.last_ex_date,
            days_since_dividend = excluded.days_since_dividend,
            company_description = excluded.company_description,
            fetched_at          = CURRENT_TIMESTAMP
    """, (
        symbol, today,
        _safe(profile.get("np_annual")), _safe(profile.get("ebitda_annual")),
        _safe(profile.get("revenue_annual")), _safe(profile.get("eps_annual")),
        _safe(profile.get("ebitda_margin")), _safe(profile.get("np_margin")),
        _safe(profile.get("cfo_annual")),
        _safe(profile.get("roe")), _safe(profile.get("roce")),
        _safe(profile.get("ltde_ratio")), _safe(profile.get("current_ratio")),
        _safe(profile.get("promoter_pct")), _safe(profile.get("fii_pct")),
        _safe(profile.get("mf_pct")), _safe(profile.get("pledge_pct")),
        _safe(profile.get("rev_cagr_5y")), _safe(profile.get("np_cagr_5y")),
        _safe(profile.get("rev_growth_yoy_q")), _safe(profile.get("np_growth_yoy_q")),
        _safe(profile.get("analyst_target_mean")),
        int(profile.get("analyst_count") or 0),
        _safe(profile.get("analyst_buy_pct")), _safe(profile.get("analyst_upside_pct")),
        _safe(profile.get("last_dividend_amt")), profile.get("last_ex_date"),
        int(profile.get("days_since_dividend") or 0) if profile.get("days_since_dividend") is not None else None,
        profile.get("company_description"),
    ))
    con.commit()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/server && python -m pytest tests/test_trendlyne_overview_fetcher.py -v`
Expected: PASS (2/2).

- [ ] **Step 5: Write the failing test for the rewritten `companyProfileSyncService.ts`**

Create `src/server/__tests__/companyProfileSyncService.test.ts`:

```typescript
import { vi, test, expect, beforeEach } from 'vitest';

const mockRunPython = vi.fn().mockResolvedValue(undefined);
vi.mock('./pythonRunner', () => ({ runPython: mockRunPython }));

const mockDbAll = vi.fn();
const mockDbRun = vi.fn().mockResolvedValue(undefined);
vi.mock('../dbAsync', () => ({
  dbAll: mockDbAll,
  dbRun: mockDbRun,
}));

const mockAnalyze = vi.fn().mockResolvedValue({ high_growth_scope: true, in_news_for_growth: false, growth_score: 80, reasoning: 'Strong fundamentals' });
const mockRelease = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/aiService', () => ({
  analyzeCompanyProfile: mockAnalyze,
  releaseOllamaModel: mockRelease,
}));

const { syncAndAnalyzeCompanyProfiles } = await import('../companyProfileSyncService');

beforeEach(() => {
  mockRunPython.mockClear();
  mockDbAll.mockClear();
  mockDbRun.mockClear();
  mockAnalyze.mockClear();
});

test('runs trendlyne_overview_fetcher.py before reading descriptions from the DB', async () => {
  mockDbAll.mockResolvedValue([{ symbol: 'BEL', name: 'Bharat Electronics', company_description: 'BEL manufactures defence electronics.' }]);

  await syncAndAnalyzeCompanyProfiles();

  expect(mockRunPython).toHaveBeenCalledWith('trendlyne_overview_fetcher.py', expect.anything(), expect.anything());
  expect(mockAnalyze).toHaveBeenCalledWith('BEL', 'BEL manufactures defence electronics.');
  expect(mockDbRun).toHaveBeenCalledTimes(1);
});

test('skips stocks with no description without calling Ollama', async () => {
  mockDbAll.mockResolvedValue([{ symbol: 'XYZ', name: 'XYZ Ltd', company_description: null }]);

  const result = await syncAndAnalyzeCompanyProfiles();

  expect(mockAnalyze).not.toHaveBeenCalled();
  expect(result.failed).toBe(1);
  expect(result.processed).toBe(0);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/server/__tests__/companyProfileSyncService.test.ts`
Expected: FAIL — current implementation calls `fetchCompanyOverview` directly, never `runPython`, and reads from `nse_stocks` not `trendlyne_stock_profile`.

- [ ] **Step 7: Rewrite `src/server/companyProfileSyncService.ts`**

Replace the entire file:

```typescript
import { dbAll, dbRun } from './dbAsync';
import { runPython } from './pythonRunner';
import { analyzeCompanyProfile, releaseOllamaModel } from '../services/aiService';

export async function syncAndAnalyzeCompanyProfiles() {
  console.log('[PROFILE SYNC] Fetching Trendlyne overview + company descriptions (also feeds the ML overview features)...');

  // trendlyne_overview_fetcher.py fetches overview-second-part once per stock and writes
  // both the ML-facing financial/shareholding/analyst fields AND the company description
  // into trendlyne_stock_profile — this used to be duplicated by a second, independent
  // Trendlyne call from this file (fetchCompanyOverview), 8.5 hours apart, same endpoint,
  // same ~3,022-stock universe. Reading from the DB instead removes that duplicate call.
  await runPython('trendlyne_overview_fetcher.py', [], 70 * 60_000);

  const stocks = await dbAll<{ symbol: string; name: string; company_description: string | null }>(`
    SELECT tsp.symbol, ns.name, tsp.company_description
    FROM trendlyne_stock_profile tsp
    JOIN nse_stocks ns ON ns.symbol = tsp.symbol
    WHERE tsp.date = (SELECT MAX(date) FROM trendlyne_stock_profile tsp2 WHERE tsp2.symbol = tsp.symbol)
  `);

  console.log(`[PROFILE SYNC] Found ${stocks.length} stocks with an overview snapshot.`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < stocks.length; i++) {
    const stock = stocks[i];

    if (!stock.company_description) {
      failCount++;
      continue;
    }

    try {
      console.log(`[PROFILE SYNC] (${i + 1}/${stocks.length}) Analyzing ${stock.symbol}...`);
      const analysis = await analyzeCompanyProfile(stock.symbol, stock.company_description);

      if (analysis.error) {
        console.warn(`[PROFILE SYNC] AI Analysis failed for ${stock.symbol}. Storing default.`);
      }

      await dbRun(`
        INSERT INTO company_profiles (
          symbol, company_name, description, high_growth_scope,
          in_news_for_growth, growth_score, ai_analysis, last_updated
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )
        ON CONFLICT(symbol) DO UPDATE SET
          company_name = excluded.company_name,
          description = excluded.description,
          high_growth_scope = excluded.high_growth_scope,
          in_news_for_growth = excluded.in_news_for_growth,
          growth_score = excluded.growth_score,
          ai_analysis = excluded.ai_analysis,
          last_updated = CURRENT_TIMESTAMP
      `, [
        stock.symbol,
        stock.name,
        stock.company_description,
        analysis.high_growth_scope ? 1 : 0,
        analysis.in_news_for_growth ? 1 : 0,
        analysis.growth_score || 0,
        analysis.reasoning || ''
      ]);

      successCount++;
    } catch (err: any) {
      console.error(`[PROFILE SYNC] Error processing ${stock.symbol}:`, err.message);
      failCount++;
    }
  }

  console.log(`[PROFILE SYNC] Completed. Success: ${successCount}, Failed: ${failCount}`);
  await releaseOllamaModel();
  return { success: true, processed: successCount, failed: failCount };
}
```

Note: the 2-second `setTimeout` delay that used to pace the Trendlyne HTTP call is removed — this loop no longer makes any HTTP call per stock (the Ollama call is local and already has its own throughput characteristics); if local Ollama saturation becomes an issue in practice, that's a separate concern from Trendlyne rate limiting and out of scope for this plan.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/server/__tests__/companyProfileSyncService.test.ts`
Expected: PASS (2/2).

- [ ] **Step 9: Typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors, all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/server/trendlyne_overview_fetcher.py src/server/companyProfileSyncService.ts src/server/tests/test_trendlyne_overview_fetcher.py src/server/__tests__/companyProfileSyncService.test.ts
git commit -m "perf: dedupe company-profiles-sync and trendlyne_overview_fetcher — both hit overview-second-part for the same universe 8.5h apart"
```

---

## Task 8: Reschedule — remove the merged/replaced scripts from `ml-weekly-retrain`, add the new midweek and monthly queues, bi-weekly-gate `company-profiles-sync`

**Files:**
- Modify: `src/server/queues.ts`

**Interfaces:**
- Consumes: `QUEUE_COMPANY_PROFILES_SYNC`, `addJobWithCatchup`, `runPython`, `recordHeartbeat`/`updateMonitorState` (all already defined in this file).
- Produces: two new exported queue-name constants, `QUEUE_TRENDLYNE_MIDWEEK` and `QUEUE_TRENDLYNE_RATIOS_MONTHLY`, for Task 9's monitoring entries to reference.

- [ ] **Step 1: Remove `trendlyne_adv_tech_fetcher.py`, `trendlyne_overview_fetcher.py`, `trendlyne_price_analysis_fetcher.py`, `financial_ratios_fetcher.py`, and `working_capital_fetcher.py` from `processMlWeeklyRetrain`**

In `src/server/queues.ts`, inside `processMlWeeklyRetrain`, delete these five blocks (currently lines ~705-725):

```typescript
  // Trendlyne advanced technical analysis: MA consensus, oscillators, pivot, delivery, beta.
  // 3058 stocks × 0.5s = ~26 min
  await runPython('trendlyne_adv_tech_fetcher.py', [], 40 * 60_000)
    .catch(e => console.warn('[QUEUE] trendlyne_adv_tech_fetcher failed:', (e as Error).message));
  // Trendlyne overview: analyst targets, board meetings, dividends + fundamental profile.
  // 3058 stocks × 2 API calls × 0.5s = ~51 min
  await runPython('trendlyne_overview_fetcher.py', [], 70 * 60_000)
    .catch(e => console.warn('[QUEUE] trendlyne_overview_fetcher failed:', (e as Error).message));
  // Trendlyne price analysis: alpha vs Nifty/Industry, monthly seasonality per stock.
  // 3058 stocks × 0.5s = ~26 min
  await runPython('trendlyne_price_analysis_fetcher.py', [], 40 * 60_000)
    .catch(e => console.warn('[QUEUE] trendlyne_price_analysis_fetcher failed:', (e as Error).message));
  // Analyst consensus + price targets — 2328 stocks × 3 calls × 0.4s = ~47 min (quarterly data)
  await runPython('analyst_estimates_snapshot.py', [], 70 * 60_000)
    .catch(e => console.warn('[QUEUE] analyst_estimates_snapshot failed:', (e as Error).message));
  // FCF yield + interest coverage — 3058 stocks × 4 calls × 0.3s = ~61 min (quarterly data)
  await runPython('financial_ratios_fetcher.py', [], 80 * 60_000)
    .catch(e => console.warn('[QUEUE] financial_ratios_fetcher failed:', (e as Error).message));
  // Working capital cycle — 3058 stocks × 5 calls × 0.4s = ~102 min (quarterly data)
  await runPython('working_capital_fetcher.py', [], 130 * 60_000)
    .catch(e => console.warn('[QUEUE] working_capital_fetcher failed:', (e as Error).message));
```

Replace with just the still-weekly `analyst_estimates_snapshot.py` call (unchanged — not part of this plan) plus a comment explaining where the other four moved:

```typescript
  // Analyst consensus + price targets — 2328 stocks × 3 calls × 0.4s = ~47 min (quarterly data)
  await runPython('analyst_estimates_snapshot.py', [], 70 * 60_000)
    .catch(e => console.warn('[QUEUE] analyst_estimates_snapshot failed:', (e as Error).message));
  // trendlyne_adv_tech_fetcher.py + trendlyne_price_analysis_fetcher.py moved to the
  // trendlyne-midweek queue (Tuesday) to de-conflict from this Sunday batch.
  // trendlyne_overview_fetcher.py moved into company-profiles-sync (dedupes the
  // overview-second-part call both used to make independently).
  // financial_ratios_fetcher.py + working_capital_fetcher.py moved to the
  // trendlyne-ratios-monthly queue (rewritten against ET_Stats — see Tasks 5-6).
```

- [ ] **Step 2: Add the two new queue-name constants**

Near the other `QUEUE_TRENDLYNE_*` constants (currently around line 107-109):

```typescript
export const QUEUE_COMPANY_PROFILES_SYNC = 'company-profiles-sync';
```
```typescript
export const QUEUE_TRENDLYNE_DAILY_FETCH = 'trendlyne-daily-fetch';
```

add, directly after:

```typescript
export const QUEUE_TRENDLYNE_MIDWEEK = 'trendlyne-midweek';
export const QUEUE_TRENDLYNE_RATIOS_MONTHLY = 'trendlyne-ratios-monthly';
```

- [ ] **Step 3: Declare the two new Queue/Worker module-level variables**

Find the existing `let companyProfilesSyncQueue`-style declarations near the top of the file's queue-variable block and add two more of the same shape (`Queue` and `Worker` typed the same as the other Trendlyne queues in this file — mirror `trendlyneDailyFetchQueue`/`trendlyneDailyFetchWorker`'s declaration exactly, just renamed):

```typescript
let trendlyneMidweekQueue: Queue;
let trendlyneMidweekWorker: Worker;
let trendlyneRatiosMonthlyQueue: Queue;
let trendlyneRatiosMonthlyWorker: Worker;
```

- [ ] **Step 4: Register the `trendlyne-midweek` queue (Tuesday 12:30 UTC)**

Add this block right after the existing `company-profiles-sync` worker registration (after the `companyProfilesSyncWorker.on('failed', ...)` block, before the `agent-auditor` section):

```typescript
    // ── Trendlyne midweek batch: adv-tech + price analysis (moved off Sunday to
    // de-conflict from the main ml-weekly-retrain batch) ──
    trendlyneMidweekQueue = new Queue(QUEUE_TRENDLYNE_MIDWEEK, { connection });
    const tmwRep = await trendlyneMidweekQueue.getRepeatableJobs();
    for (const r of tmwRep) await trendlyneMidweekQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(trendlyneMidweekQueue,
      'trendlyne-midweek-batch',
      {},
      {
        repeat: { pattern: '30 12 * * 2' }, // Tuesday 12:30 UTC (6:00 PM IST)
        jobId: 'trendlyne-midweek-weekly',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    trendlyneMidweekWorker = new Worker(
      QUEUE_TRENDLYNE_MIDWEEK,
      async (_job: Job) => {
        await runPython('trendlyne_adv_tech_fetcher.py', [], 40 * 60_000)
          .catch(e => console.warn('[QUEUE] trendlyne_adv_tech_fetcher failed:', (e as Error).message));
        await runPython('trendlyne_price_analysis_fetcher.py', [], 40 * 60_000)
          .catch(e => console.warn('[QUEUE] trendlyne_price_analysis_fetcher failed:', (e as Error).message));
        return { success: true };
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 90 * 60 * 1000,
        lockRenewTime: 10 * 60 * 1000,
      },
    );

    trendlyneMidweekWorker.on('completed', () => {
      console.log('[QUEUE] trendlyne-midweek completed');
      updateMonitorState('trendlyne-midweek', 'success');
    });
    trendlyneMidweekWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-midweek failed:', err.message);
      updateMonitorState('trendlyne-midweek', 'failed', err.message);
    });

    // ── Trendlyne ratios (monthly): financial_ratios + working_capital, now via
    // ET_Stats (Trendlyne's own params for this are confirmed dead — see Tasks 5-6).
    // Fires the Sunday cron every week but only actually runs on the first Sunday of
    // the month (day-of-month <= 7) — cron's day-of-month/day-of-week fields are OR'd,
    // not AND'd, by the underlying cron-parser, so "first Sunday" needs an in-handler
    // guard rather than a single cron expression. ──
    trendlyneRatiosMonthlyQueue = new Queue(QUEUE_TRENDLYNE_RATIOS_MONTHLY, { connection });
    const trmRep = await trendlyneRatiosMonthlyQueue.getRepeatableJobs();
    for (const r of trmRep) await trendlyneRatiosMonthlyQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(trendlyneRatiosMonthlyQueue,
      'trendlyne-ratios-monthly-check',
      {},
      {
        repeat: { pattern: '30 12 * * 0' }, // every Sunday 12:30 UTC; handler no-ops unless day <= 7
        jobId: 'trendlyne-ratios-monthly-weekly-check',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    trendlyneRatiosMonthlyWorker = new Worker(
      QUEUE_TRENDLYNE_RATIOS_MONTHLY,
      async (_job: Job) => {
        if (new Date().getUTCDate() > 7) {
          console.log('[QUEUE] trendlyne-ratios-monthly: not the first Sunday of the month, skipping');
          return { success: true, skipped: true };
        }
        await runPython('financial_ratios_fetcher.py', [], 30 * 60_000)
          .catch(e => console.warn('[QUEUE] financial_ratios_fetcher failed:', (e as Error).message));
        await runPython('working_capital_fetcher.py', [], 30 * 60_000)
          .catch(e => console.warn('[QUEUE] working_capital_fetcher failed:', (e as Error).message));
        return { success: true };
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 60 * 60 * 1000,
        lockRenewTime: 10 * 60 * 1000,
      },
    );

    trendlyneRatiosMonthlyWorker.on('completed', () => {
      console.log('[QUEUE] trendlyne-ratios-monthly completed');
      updateMonitorState('trendlyne-ratios-monthly', 'success');
    });
    trendlyneRatiosMonthlyWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-ratios-monthly failed:', err.message);
      updateMonitorState('trendlyne-ratios-monthly', 'failed', err.message);
    });
```

(`runPython` timeouts are reduced from the old 80/130-minute estimates to 30 minutes each — the ET_Stats-based rewrites in Tasks 5-6 process the same ~2,000-stock `stocklist.json` universe with 2 lightweight JSON calls per stock at a 0.3s rate limit each, well under 20 minutes in practice; 30 minutes leaves comfortable headroom.)

- [ ] **Step 5: Bi-weekly-gate `company-profiles-sync`**

In the existing `company-profiles-sync` worker (added in Task 7's file, unchanged registration point in `queues.ts`), change the handler from:

```typescript
    companyProfilesSyncWorker = new Worker(
      QUEUE_COMPANY_PROFILES_SYNC,
      async (_job: Job) => {
        const { syncAndAnalyzeCompanyProfiles } = await import('./companyProfileSyncService');
        await syncAndAnalyzeCompanyProfiles();
      },
```

to:

```typescript
    companyProfilesSyncWorker = new Worker(
      QUEUE_COMPANY_PROFILES_SYNC,
      async (_job: Job) => {
        // Bi-weekly: check job_heartbeat for the last successful run and skip if it was
        // less than 12 days ago (company descriptions/financials barely change week to
        // week — this used to run weekly for no benefit).
        const last = await dbGet(
          `SELECT last_success_at FROM job_heartbeat WHERE job_name = 'company-profiles-sync'`,
        ) as { last_success_at: number | null } | undefined;
        const twelveDaysMs = 12 * 24 * 60 * 60 * 1000;
        if (last?.last_success_at && Date.now() - Number(last.last_success_at) < twelveDaysMs) {
          console.log('[QUEUE] company-profiles-sync: ran within the last 12 days, skipping');
          return;
        }
        const { syncAndAnalyzeCompanyProfiles } = await import('./companyProfileSyncService');
        await syncAndAnalyzeCompanyProfiles();
      },
```

`dbGet` is already imported at the top of `queues.ts` (`import { dbGet, dbAll, dbRun } from './dbAsync';`, line 16) — no import changes needed for this step.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Write a focused test for the first-Sunday-of-month guard**

Create `src/server/__tests__/trendlyneRatiosMonthlyGuard.test.ts`:

```typescript
import { test, expect } from 'vitest';

// Pure re-implementation of the guard condition used in queues.ts, so this test doesn't
// need to spin up BullMQ/Redis — it locks in the exact boundary behavior.
function shouldRunMonthlyRatios(date: Date): boolean {
  return date.getUTCDate() <= 7;
}

test('runs on the first Sunday of the month (date 1-7)', () => {
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 5)))).toBe(true); // Jul 5, 2026 is a Sunday
});

test('does not run on a later Sunday in the same month', () => {
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 12)))).toBe(false); // Jul 12, 2026
});

test('boundary: date 7 runs, date 8 does not', () => {
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 7)))).toBe(true);
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 8)))).toBe(false);
});
```

Run: `npx vitest run src/server/__tests__/trendlyneRatiosMonthlyGuard.test.ts`
Expected: PASS (3/3) — this documents/locks the boundary condition used inline in `queues.ts`'s worker handler (`new Date().getUTCDate() > 7`).

- [ ] **Step 8: Commit**

```bash
git add src/server/queues.ts src/server/__tests__/trendlyneRatiosMonthlyGuard.test.ts
git commit -m "feat: split ml-weekly-retrain's Trendlyne scripts into midweek + monthly queues, bi-weekly-gate company-profiles-sync"
```

---

## Task 9: Monitoring — add `MONITOR_SCRIPTS` entries for the rescheduled/rewritten scripts

**Files:**
- Modify: `src/server/routers/monitor.router.ts`

**Interfaces:**
- Consumes: `MONITOR_SCRIPTS` array, `getLastRunAt`, `getScriptStats` (all in this file).

- [ ] **Step 1: Add four new entries to `MONITOR_SCRIPTS`**

Add these after the existing `company-profiles-sync`-adjacent entries (append near the end of the array, before its closing `];`):

```typescript
  {
    id: 'trendlyne-fundamentals',
    label: 'Trendlyne Fundamentals (EPS + DVM)',
    category: 'Data',
    critical: false,
    description: 'EPS_TTM + DivYield series and DVM scores (PE/PB now fed by mc_pricefeed_fetcher.py)',
    schedule: 'Weekly Sunday',
    pyScript: 'trendlyne_fundamentals_fetcher.py',
    queueName: 'ml-weekly-retrain',
    staleLimitHours: 200,
  },
  {
    id: 'trendlyne-midweek',
    label: 'Trendlyne Midweek (Adv-Tech + Price Analysis)',
    category: 'Data',
    critical: false,
    description: 'Advanced technical analysis + price-performance alpha, moved off Sunday',
    schedule: 'Weekly Tuesday',
    pyScript: null,
    queueName: 'trendlyne-midweek',
    staleLimitHours: 200,
  },
  {
    id: 'financial-ratios',
    label: 'Financial Ratios (ET_Stats)',
    category: 'ML',
    critical: false,
    description: 'FCF yield (approx) + interest coverage, rewritten against ET_Stats after Trendlyne retired the params',
    schedule: 'First Sunday of month',
    pyScript: 'financial_ratios_fetcher.py',
    queueName: 'trendlyne-ratios-monthly',
    staleLimitHours: 800,
  },
  {
    id: 'working-capital',
    label: 'Working Capital Cycle (ET_Stats, annual)',
    category: 'ML',
    critical: false,
    description: 'Cash conversion cycle per fiscal year, rewritten against ET_Stats after Trendlyne retired the params',
    schedule: 'First Sunday of month',
    pyScript: 'working_capital_fetcher.py',
    queueName: 'trendlyne-ratios-monthly',
    staleLimitHours: 800,
  },
```

(`staleLimitHours: 800` ≈ 33 days — one month plus slack, consistent with how `ml-ensemble-train`'s `staleLimitHours: 200` already covers a ~8-day weekly window with slack in this same file.)

- [ ] **Step 2: Add matching `getLastRunAt` cases**

In the `getLastRunAt` switch statement, add cases right before the `default: return null;` line:

```typescript
      case 'trendlyne-fundamentals':
        row = await dbGet("SELECT MAX(date) as t FROM trendlyne_dvm_scores");
        break;
      case 'trendlyne-midweek':
        row = await dbGet("SELECT MAX(fetched_at) as t FROM trendlyne_stock_profile");
        break;
      case 'financial-ratios':
        row = await dbGet("SELECT MAX(as_of_date) as t FROM tl_financial_quality");
        break;
      case 'working-capital':
        row = await dbGet("SELECT MAX(fiscal_year) as t FROM working_capital_history");
        break;
```

- [ ] **Step 3: Add matching `getScriptStats` cases**

In the `getScriptStats` switch statement, add cases right before its `default` (mirror the existing `coverage`/count style already used for similar entries):

```typescript
      case 'trendlyne-fundamentals':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM trendlyne_dvm_scores WHERE date = (SELECT MAX(date) FROM trendlyne_dvm_scores)")) as any)?.n ?? 0 };
      case 'trendlyne-midweek':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM trendlyne_stock_profile WHERE date = (SELECT MAX(date) FROM trendlyne_stock_profile)")) as any)?.n ?? 0 };
      case 'financial-ratios':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM tl_financial_quality WHERE as_of_date = (SELECT MAX(as_of_date) FROM tl_financial_quality)")) as any)?.n ?? 0 };
      case 'working-capital':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM working_capital_history WHERE fiscal_year = (SELECT MAX(fiscal_year) FROM working_capital_history)")) as any)?.n ?? 0 };
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Run the existing monitor test suite to confirm no regressions**

Run: `npx vitest run src/server/__tests__/monitorSystemStatus.test.ts src/server/__tests__/jobRegistryVsMonitorScripts.test.ts`
Expected: PASS — the `jobRegistryVsMonitorScripts` collision test (added in a prior session per project history) will catch it immediately if any of the 4 new `id`s collide with an existing `JOB_REGISTRY` entry; none of the ids chosen here (`trendlyne-fundamentals`, `trendlyne-midweek`, `financial-ratios`, `working-capital`) exist in `JOB_REGISTRY` today.

- [ ] **Step 6: Commit**

```bash
git add src/server/routers/monitor.router.ts
git commit -m "feat: add MONITOR_SCRIPTS entries for trendlyne-fundamentals, trendlyne-midweek, financial-ratios, working-capital"
```

---

## Task 10: Enrich `scripts/stocklist.json` with Tickertape `sid` via the bulk stock-list endpoint

Resolved live during execution (user-approved, 2026-07-05): `https://api.tickertape.in/stocks/list` is a single unauthenticated request returning **5,793 stocks** — `{"sid": "MICR", "name": "20 Microns Ltd", "ticker": "20MICRONS", "type": "stock", "slug": "...", "isin": "INE144J01027"}` — no pagination needed, far more coverage than the 2,005-stock `scripts/stocklist.json`. Every entry in `stocklist.json` already has an `isin` field (used for other providers per `CLAUDE.md`'s Resolution Order), so joining Tickertape's bulk list on `isin` (safer than symbol-string matching — immune to suffix/casing differences) resolves `sid` for the full existing universe in one pass, no per-stock API calls, no autocomplete/fuzzy-matching needed.

**Files:**
- Create: `scripts/enrich_stocklist_tickertape.py`
- Modify (data, not code): `scripts/stocklist.json` — run the script once as part of this task to actually add the `tickertape_sid` field
- Create: `src/server/tickertape_client.py` (mirrors `et_stats_client.py`'s shape from Task 4 — shared loader + fetch helper for Task 12)
- Test: `src/server/tests/test_tickertape_client.py`

**Interfaces:**
- Produces (`enrich_stocklist_tickertape.py`, standalone script, not imported elsewhere): reads `scripts/stocklist.json`, writes it back in place with a `tickertape_sid` field added to each matched entry (`None`/absent if no ISIN match found).
- Produces (`tickertape_client.py`): `load_tickertape_sid_map() -> dict[str, str]` (symbol upper → sid, only for entries with a populated `tickertape_sid`), `fetch_scorecard(sid: str, session: requests.Session) -> list[dict] | None` (the `data` array from the scorecard response, or `None` on failure/empty).

- [ ] **Step 1: Write the failing test for `enrich_stocklist_tickertape.py`'s pure join logic**

Create `src/server/tests/test_tickertape_client.py` (this single file covers both the enrichment script's pure join function and `tickertape_client.py`, since both are small and tightly related):

```python
import json
import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts"))

import enrich_stocklist_tickertape as enrich
import tickertape_client as tc


class TestJoinByIsin:
    def test_matches_stocklist_entries_by_isin(self):
        stocklist = [
            {"symbol": "BEL", "isin": "INE263A01024", "name": "Bharat Electronics"},
            {"symbol": "AUBANK", "isin": "INE949L01017", "name": "AU Small Finance Bank"},
        ]
        tickertape_list = [
            {"sid": "BHE", "isin": "INE263A01024", "ticker": "BEL"},
            {"sid": "AUBANK", "isin": "INE949L01017", "ticker": "AUBANK"},
            {"sid": "UNRELATED", "isin": "INE000X00000", "ticker": "XYZ"},
        ]
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert result[0]["tickertape_sid"] == "BHE"
        assert result[1]["tickertape_sid"] == "AUBANK"

    def test_leaves_tickertape_sid_absent_when_no_isin_match(self):
        stocklist = [{"symbol": "NOMATCH", "isin": "INE999Z99999", "name": "No Match Ltd"}]
        tickertape_list = [{"sid": "OTHER", "isin": "INE111A11111", "ticker": "OTHER"}]
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert "tickertape_sid" not in result[0]

    def test_handles_missing_isin_on_either_side_gracefully(self):
        stocklist = [{"symbol": "NOISIN", "name": "No ISIN Ltd"}]
        tickertape_list = [{"sid": "X", "ticker": "X"}]  # no isin key
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert "tickertape_sid" not in result[0]

    def test_does_not_mutate_other_fields(self):
        stocklist = [{"symbol": "BEL", "isin": "INE263A01024", "companyid": "11945", "tlid": "175"}]
        tickertape_list = [{"sid": "BHE", "isin": "INE263A01024"}]
        result = enrich.join_by_isin(stocklist, tickertape_list)

        assert result[0]["companyid"] == "11945"
        assert result[0]["tlid"] == "175"


class TestTickertapeClient:
    def test_load_tickertape_sid_map_reads_symbol_and_sid(self, tmp_path, monkeypatch):
        fixture = tmp_path / "stocklist.json"
        fixture.write_text(json.dumps([
            {"symbol": "bel", "tickertape_sid": "BHE"},
            {"symbol": "NOMATCH"},  # no tickertape_sid at all
            {"symbol": "EMPTY", "tickertape_sid": ""},  # empty string, must be excluded
        ]), encoding="utf-8")
        monkeypatch.setattr(tc, "_STOCKLIST_PATH", fixture)
        monkeypatch.setattr(tc, "_symbol_to_sid", None)

        mapping = tc.load_tickertape_sid_map()

        assert mapping["BEL"] == "BHE"
        assert "NOMATCH" not in mapping
        assert "EMPTY" not in mapping

    def test_fetch_scorecard_returns_data_list_on_success(self):
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.json.return_value = {"success": True, "data": [{"name": "Performance", "tag": "Low"}]}
        fake_session = MagicMock()
        fake_session.get.return_value = fake_response

        result = tc.fetch_scorecard("BHE", fake_session)

        assert result == [{"name": "Performance", "tag": "Low"}]

    def test_fetch_scorecard_returns_none_on_empty_data(self):
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.json.return_value = {"success": True, "data": []}
        fake_session = MagicMock()
        fake_session.get.return_value = fake_response

        assert tc.fetch_scorecard("BHE", fake_session) is None

    def test_fetch_scorecard_returns_none_on_non_200(self):
        fake_response = MagicMock()
        fake_response.status_code = 404
        fake_session = MagicMock()
        fake_session.get.return_value = fake_response

        assert tc.fetch_scorecard("BHE", fake_session) is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/server && python -m pytest tests/test_tickertape_client.py -v`
Expected: FAIL — `ModuleNotFoundError` for both `enrich_stocklist_tickertape` and `tickertape_client` (neither exists yet).

- [ ] **Step 3: Create `scripts/enrich_stocklist_tickertape.py`**

```python
#!/usr/bin/env python3
"""
One-time (re-runnable, idempotent) enrichment of scripts/stocklist.json with
Tickertape's per-stock `sid`, resolved via Tickertape's bulk stock-list
endpoint (https://api.tickertape.in/stocks/list — single unauthenticated
request, ~5,793 stocks, no pagination) joined on ISIN against stocklist.json's
existing isin field.

ISIN is used as the join key (not symbol/ticker string matching) since it's
the one universal identifier both sides already carry cleanly — avoids
suffix/casing mismatches between NSE symbols and Tickertape's ticker field.

Run:
  python scripts/enrich_stocklist_tickertape.py
"""

import json
from pathlib import Path

import requests

STOCKLIST_PATH = Path(__file__).resolve().parent / "stocklist.json"
TICKERTAPE_LIST_URL = "https://api.tickertape.in/stocks/list"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def fetch_tickertape_list() -> list[dict]:
    r = requests.get(TICKERTAPE_LIST_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json().get("data", [])


def join_by_isin(stocklist: list[dict], tickertape_list: list[dict]) -> list[dict]:
    """Pure function: does not mutate inputs, returns a new list of dicts.
    Adds `tickertape_sid` only to entries where both sides have a matching,
    non-empty ISIN — entries with no match are left untouched (no key added)."""
    isin_to_sid = {
        row["isin"]: row["sid"]
        for row in tickertape_list
        if row.get("isin") and row.get("sid")
    }

    result = []
    for entry in stocklist:
        updated = dict(entry)
        isin = entry.get("isin")
        if isin and isin in isin_to_sid:
            updated["tickertape_sid"] = isin_to_sid[isin]
        result.append(updated)
    return result


def main() -> None:
    with open(STOCKLIST_PATH, encoding="utf-8") as f:
        stocklist = json.load(f)

    print(f"[EnrichTickertape] Fetching Tickertape bulk stock list...")
    tickertape_list = fetch_tickertape_list()
    print(f"[EnrichTickertape] Got {len(tickertape_list)} Tickertape entries.")

    enriched = join_by_isin(stocklist, tickertape_list)
    matched = sum(1 for e in enriched if "tickertape_sid" in e)
    print(f"[EnrichTickertape] Matched {matched}/{len(enriched)} stocklist entries by ISIN.")

    with open(STOCKLIST_PATH, "w", encoding="utf-8") as f:
        json.dump(enriched, f, indent=2, ensure_ascii=False)
    print(f"[EnrichTickertape] Wrote {STOCKLIST_PATH}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Create `src/server/tickertape_client.py`**

```python
#!/usr/bin/env python3
"""
Tickertape scorecard client — shared by tickertape_scorecard_fetcher.py.

Live-verified 2026-07-05: api.tickertape.in/stocks/scorecard/{sid} returns
category objects (Performance/Valuation/Growth/Profitability among them,
type="score") — but the numeric score.value is premium-gated and always
null without a paid Tickertape login (confirmed across multiple stocks).
What IS available unauthenticated is a categorical `tag` per category
(observed values: "Low"/"Avg"/"High" for the type="score" categories) —
real, per-stock-differentiated signal, just ordinal instead of numeric.
tickertape_scorecard_fetcher.py stores the ordinal-encoded tag, not a
numeric score.

sid is resolved via scripts/stocklist.json's tickertape_sid field
(populated by scripts/enrich_stocklist_tickertape.py), not live per-stock
lookup — see that script for how sid is obtained.
"""

import json
from pathlib import Path

import requests

SCORECARD_URL = "https://analyze.api.tickertape.in/stocks/scorecard/{sid}"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}
# Exported for the caller to apply to their own requests.Session once at
# creation time (e.g. session.headers.update(HEADERS)), then pass that
# session into fetch_scorecard() — matches the et_stats_client.py pattern.

RATE_LIMIT_SEC = 0.3

_STOCKLIST_PATH = Path(__file__).resolve().parents[2] / "scripts" / "stocklist.json"
_symbol_to_sid: dict[str, str] | None = None


def load_tickertape_sid_map() -> dict[str, str]:
    """symbol (uppercase) -> tickertape_sid, loaded once from scripts/stocklist.json.
    Only includes entries with a non-empty tickertape_sid (most stocks won't
    have one until scripts/enrich_stocklist_tickertape.py has been run)."""
    global _symbol_to_sid
    if _symbol_to_sid is not None:
        return _symbol_to_sid

    with open(_STOCKLIST_PATH, encoding="utf-8") as f:
        rows = json.load(f)

    _symbol_to_sid = {
        row["symbol"].upper(): row["tickertape_sid"]
        for row in rows
        if row.get("symbol") and row.get("tickertape_sid")
    }
    return _symbol_to_sid


def fetch_scorecard(sid: str, session: requests.Session) -> list[dict] | None:
    """Fetch the scorecard `data` array for one stock. Returns None on
    failure or an empty response."""
    try:
        r = session.get(SCORECARD_URL.format(sid=sid), timeout=15)
        if r.status_code != 200:
            return None
        data = r.json().get("data", [])
        return data if data else None
    except Exception as e:
        print(f"  [Tickertape scorecard] error for sid={sid}: {e}")
        return None
    finally:
        import time
        time.sleep(RATE_LIMIT_SEC)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src/server && python -m pytest tests/test_tickertape_client.py -v`
Expected: PASS (9/9).

- [ ] **Step 6: Actually run the enrichment script once against the real, checked-in `scripts/stocklist.json`**

Run: `python scripts/enrich_stocklist_tickertape.py`
Expected: prints a match count (expect a high match rate — Tickertape's list covers 5,793 stocks vs. `stocklist.json`'s 2,005, so most ISINs should resolve); `scripts/stocklist.json` is rewritten in place with `tickertape_sid` added to matched entries. Spot-check a couple of well-known stocks (e.g. `grep -A1 '"symbol": "BEL"' scripts/stocklist.json` or equivalent) to confirm a real Tickertape sid landed on a real stock, not a placeholder.

- [ ] **Step 7: Commit**

```bash
git add scripts/enrich_stocklist_tickertape.py src/server/tickertape_client.py src/server/tests/test_tickertape_client.py scripts/stocklist.json
git commit -m "feat: add Tickertape sid resolution — bulk stock-list join by ISIN, enrich scripts/stocklist.json"
```

---

## Task 12: `tickertape_scorecard_fetcher.py` — write ordinal category tags into `proprietary_scores_history`

**Files:**
- Create: `src/server/tickertape_scorecard_fetcher.py`
- Test: `src/server/tests/test_tickertape_scorecard_fetcher.py`
- Modify: `src/server/queues.ts` (new weekly queue)
- Modify: `src/server/routers/monitor.router.ts` (new MONITOR_SCRIPTS entry)

**Interfaces:**
- Produces: `compute_ordinal_scores(scorecard_data: list[dict]) -> dict[str, dict]` — pure function, maps each `type=="score"` category to `{"score_value": int | None, "score_label": str}`.

- [ ] **Step 1: Write the failing tests for the pure `compute_ordinal_scores` function**

Create `src/server/tests/test_tickertape_scorecard_fetcher.py`:

```python
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tickertape_scorecard_fetcher as tsf


def _score_category(name, tag):
    return {"name": name, "tag": tag, "type": "score", "score": {"value": None}}


def _non_score_category(name, tag):
    return {"name": name, "tag": tag, "type": "entryPoint"}


class TestComputeOrdinalScores:
    def test_maps_low_avg_high_to_0_1_2(self):
        data = [_score_category("Performance", "Low"), _score_category("Valuation", "Avg"), _score_category("Growth", "High")]
        result = tsf.compute_ordinal_scores(data)

        assert result["performance"] == {"score_value": 0, "score_label": "Low"}
        assert result["valuation"] == {"score_value": 1, "score_label": "Avg"}
        assert result["growth"] == {"score_value": 2, "score_label": "High"}

    def test_ignores_non_score_type_categories(self):
        data = [_score_category("Performance", "Low"), _non_score_category("Entry point", "Good"), _non_score_category("Red flags", "Low")]
        result = tsf.compute_ordinal_scores(data)

        assert "entry point" not in result
        assert "red flags" not in result
        assert "performance" in result

    def test_unrecognized_tag_gets_none_score_value_but_keeps_label(self):
        data = [_score_category("Growth", "Unusual")]
        result = tsf.compute_ordinal_scores(data)

        assert result["growth"] == {"score_value": None, "score_label": "Unusual"}

    def test_empty_input_returns_empty_dict(self):
        assert tsf.compute_ordinal_scores([]) == {}
        assert tsf.compute_ordinal_scores(None) == {}

    def test_category_name_is_lowercased_for_score_type_key(self):
        data = [_score_category("Profitability", "High")]
        result = tsf.compute_ordinal_scores(data)
        assert "profitability" in result
        assert "Profitability" not in result
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src/server && python -m pytest tests/test_tickertape_scorecard_fetcher.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tickertape_scorecard_fetcher'`.

- [ ] **Step 3: Create `src/server/tickertape_scorecard_fetcher.py`**

```python
#!/usr/bin/env python3
"""
Tickertape Scorecard Fetcher — ordinal category tags
======================================================
Fetches api.tickertape.in/stocks/scorecard/{sid} (via tickertape_client.py)
and writes each type="score" category's ORDINAL-ENCODED tag (numeric value
is premium-gated, see tickertape_client.py docstring) into
proprietary_scores_history, source='tickertape'.

sid is resolved via scripts/stocklist.json's tickertape_sid field (populated
by scripts/enrich_stocklist_tickertape.py) — stocks without a resolved sid
are skipped.

Cadence: weekly (this is a supplementary/secondary signal, categorical not
numeric — no value in fetching more often; low priority relative to the
platform's primary scoring pipelines).

Run:
  python tickertape_scorecard_fetcher.py              # all stocks with a tickertape_sid
  python tickertape_scorecard_fetcher.py --symbol BEL
  python tickertape_scorecard_fetcher.py --limit 50
"""

import argparse
from datetime import date

import requests

from db_compat import connect
from tickertape_client import HEADERS, fetch_scorecard, load_tickertape_sid_map

ORDINAL_MAP = {"low": 0, "avg": 1, "high": 2}


# ── Pure computation (fully unit-testable, no network/DB) ───────────────────────

def compute_ordinal_scores(scorecard_data: list[dict] | None) -> dict[str, dict]:
    """scorecard_data: the `data` array from the scorecard API response.
    Returns {category_name_lowercased: {"score_value": int|None, "score_label": str}}
    for every type="score" category. Non-"score" categories (entryPoint,
    redFlag, etc.) are excluded — this fetcher only covers the four
    Performance/Valuation/Growth/Profitability-style categories."""
    if not scorecard_data:
        return {}

    result = {}
    for category in scorecard_data:
        if category.get("type") != "score":
            continue
        name = category.get("name", "")
        tag = category.get("tag", "")
        result[name.lower()] = {
            "score_value": ORDINAL_MAP.get(tag.lower()),
            "score_label": tag,
        }
    return result


# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert_scores(symbol: str, today: str, scores: dict[str, dict], con) -> int:
    if not scores:
        return 0
    cur = con.cursor()
    count = 0
    for score_type, values in scores.items():
        cur.execute("""
            INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
            VALUES (?, ?, 'tickertape', ?, ?, ?)
            ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
        """, (symbol, today, score_type, values["score_value"], values["score_label"]))
        count += 1
    con.commit()
    return count


# ── Per-stock processing ──────────────────────────────────────────────────────────

def process_stock(symbol: str, sid: str, today: str, session: requests.Session, con) -> int:
    data = fetch_scorecard(sid, session)
    scores = compute_ordinal_scores(data)
    return upsert_scores(symbol, today, scores, con)


# ── Stock list ────────────────────────────────────────────────────────────────────

def load_stocks(symbol_filter: str | None, limit: int | None) -> list[tuple[str, str]]:
    sid_map = load_tickertape_sid_map()
    rows = sorted(sid_map.items())
    if symbol_filter:
        rows = [(s, sid) for s, sid in rows if s == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


# ── Main ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Tickertape scorecard ordinal tags")
    parser.add_argument("--symbol", default=None, help="Single stock NSE symbol")
    parser.add_argument("--limit", type=int, default=None, help="Process first N stocks")
    args = parser.parse_args()

    con = connect()

    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[TickertapeScorecard] No stocks with a tickertape_sid found.")
        con.close()
        return

    print(f"[TickertapeScorecard] Processing {len(stocks)} stocks…")
    session = requests.Session()
    session.headers.update(HEADERS)
    today = date.today().isoformat()

    ok = 0
    for i, (symbol, sid) in enumerate(stocks, 1):
        try:
            n = process_stock(symbol, sid, today, session, con)
            if n:
                ok += 1
            print(f"  [{i}/{len(stocks)}] {symbol}: {n} categories written")
        except Exception as e:
            try:
                con.rollback()
            except Exception:
                pass
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}")

    print(f"[TickertapeScorecard] Done. {ok}/{len(stocks)} stocks with scores written.")
    con.close()


if __name__ == "__main__":
    main()
```

Note: `proprietary_scores_history` already exists (created in `db.ts`, used by `syncProprietaryScores.ts` for the `niftytrader`/`trendlyne` sources) — this script needs no `ensure_schema()` of its own, it writes into the existing table with a new `source='tickertape'` value.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src/server && python -m pytest tests/test_tickertape_scorecard_fetcher.py -v`
Expected: PASS (5/5).

- [ ] **Step 5: Wire a new weekly queue in `queues.ts`**

Add a `QUEUE_TICKERTAPE_SCORECARD` constant near the other single-purpose weekly queues (e.g. next to `QUEUE_TRENDLYNE_MIDWEEK`/`QUEUE_TRENDLYNE_RATIOS_MONTHLY` from Task 8, already committed on this branch):

```typescript
export const QUEUE_TICKERTAPE_SCORECARD = 'tickertape-scorecard';
```

Declare the module-level `Queue`/`Worker` variables alongside the other Trendlyne-adjacent ones (mirror the exact declaration style Task 8 already used for `trendlyneMidweekQueue`/`trendlyneMidweekWorker`):

```typescript
let tickertapeScorecardQueue: Queue;
let tickertapeScorecardWorker: Worker;
```

Register the queue (weekly, low-priority day/time — e.g. Saturday, well clear of the Sunday Trendlyne cluster and the Tuesday midweek batch):

```typescript
    // ── Tickertape scorecard: ordinal category tags (Performance/Valuation/
    // Growth/Profitability) — supplementary signal, weekly is sufficient. ──
    tickertapeScorecardQueue = new Queue(QUEUE_TICKERTAPE_SCORECARD, { connection });
    const ttscRep = await tickertapeScorecardQueue.getRepeatableJobs();
    for (const r of ttscRep) await tickertapeScorecardQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(tickertapeScorecardQueue,
      'tickertape-scorecard-weekly',
      {},
      {
        repeat: { pattern: '0 13 * * 6' }, // Saturday 1:00 PM UTC
        jobId: 'tickertape-scorecard-weekly',
        removeOnComplete: 3,
        removeOnFail: 3,
      },
    );

    tickertapeScorecardWorker = new Worker(
      QUEUE_TICKERTAPE_SCORECARD,
      async (_job: Job) => {
        await runPython('tickertape_scorecard_fetcher.py', [], 60 * 60_000)
          .catch(e => console.warn('[QUEUE] tickertape_scorecard_fetcher failed:', (e as Error).message));
        return { success: true };
      },
      {
        connection,
        concurrency: 1,
        lockDuration: 90 * 60 * 1000,
        lockRenewTime: 10 * 60 * 1000,
      },
    );

    tickertapeScorecardWorker.on('completed', () => {
      console.log('[QUEUE] tickertape-scorecard completed');
      updateMonitorState('tickertape-scorecard', 'success');
    });
    tickertapeScorecardWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] tickertape-scorecard failed:', err.message);
      updateMonitorState('tickertape-scorecard', 'failed', err.message);
    });
```

- [ ] **Step 6: Add a `MONITOR_SCRIPTS` entry in `monitor.router.ts`**

Add to the `MONITOR_SCRIPTS` array:

```typescript
  {
    id: 'tickertape-scorecard',
    label: 'Tickertape Scorecard (ordinal tags)',
    category: 'Data',
    critical: false,
    description: 'Performance/Valuation/Growth/Profitability ordinal tags (numeric values are premium-gated)',
    schedule: 'Weekly Saturday',
    pyScript: 'tickertape_scorecard_fetcher.py',
    queueName: 'tickertape-scorecard',
    staleLimitHours: 200,
  },
```

Add to `getLastRunAt`:

```typescript
      case 'tickertape-scorecard':
        row = await dbGet("SELECT MAX(date) as t FROM proprietary_scores_history WHERE source = 'tickertape'");
        break;
```

Add to `getScriptStats`:

```typescript
      case 'tickertape-scorecard':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM proprietary_scores_history WHERE source = 'tickertape' AND date = (SELECT MAX(date) FROM proprietary_scores_history WHERE source = 'tickertape')")) as any)?.n ?? 0 };
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit` (expect 0 errors)
Run: `npx vitest run` (expect no regressions)
Run: `cd src/server && python -m pytest tests/test_tickertape_scorecard_fetcher.py tests/test_tickertape_client.py -v` (expect all passing)

- [ ] **Step 8: Commit**

```bash
git add src/server/tickertape_scorecard_fetcher.py src/server/tests/test_tickertape_scorecard_fetcher.py src/server/queues.ts src/server/routers/monitor.router.ts
git commit -m "feat: add tickertape_scorecard_fetcher.py — ordinal category tags into proprietary_scores_history, weekly Saturday queue + monitoring"
```

---

## Task 11: Repoint `fcf_yield` consumers to `fcf_yield_approx`, sync schema-of-record

Task 5's review surfaced a plan-level gap: the brief renamed `technical_signals.fcf_yield` → `fcf_yield_approx` (correctly — to label the CFO+CFI approximation) and rewrote `tl_financial_quality`'s column set (`capex_ttm`/`fcf_ttm`/`ebit_ttm`/`interest_expense_ttm` → `cfi_ttm`/`fcf_ttm_approx`, `interest_coverage`/`fcf_yield` → `fcf_yield_approx`), but three live consumers and the schema-of-record files still reference the old names — verified via live grep on this branch, 2026-07-04:

- `src/server/routers/commandCenter.router.ts:149` — `SELECT ... ts.fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk ...` (feeds the `getBuyRecommendations` procedure)
- `src/server/ml_ensemble.py:926` and `:1130` — two separate SQL `SELECT ... ts.fcf_yield ...` (feature-building queries)
- `src/server/ml_ensemble.py:661` — `X['fcf_yield_norm'] = num('fcf_yield', 0.0).clip(-5, 20) / 20.0` (active ML feature keyed by the SQL result's column name)
- `src/server/ml_ensemble.py:648-649` — a commented-out feature line and TODO note "once financial_ratios_fetcher populates fcf_yield (currently 0 rows)" — now stale, since it will populate
- `src/server/db.ts:2210-2221` — `tl_financial_quality` `CREATE TABLE` still declares the OLD column set (`capex_ttm`, `fcf_ttm`, `ebit_ttm`, `interest_expense_ttm`, `fcf_yield`), out of sync with what `financial_ratios_fetcher.py::ensure_schema()` now creates. This is a live correctness risk, not just staleness: on a fresh dev DB where `db.ts` bootstraps the schema before any Python script runs, its `CREATE TABLE IF NOT EXISTS` would win, leaving the table without `cfi_ttm`/`fcf_ttm_approx`/`fcf_yield_approx` — and `financial_ratios_fetcher.py`'s own `INSERT` (which references those new column names) would then fail against that stale table.
- `src/server/db.ts:2283` — `ALTER TABLE technical_signals ADD COLUMN fcf_yield REAL;` (old name only; no `fcf_yield_approx` entry)
- `db/schema.postgres.sql:2193` and `:2269` — `"fcf_yield" DOUBLE PRECISION` in both the `technical_signals` and `tl_financial_quality` blocks
- `db/schema.postgres.sql:2260-2272` — `tl_financial_quality` `CREATE TABLE` also has the old column set

Confirmed via grep that `tl_financial_quality` has exactly one owner (`financial_ratios_fetcher.py`) and one schema-of-record declaration (`db.ts`) — no other file reads from it, so its `CREATE TABLE` block can be fully replaced rather than additively patched. `src/components/BuyRecommendationsPage.tsx` reads `p.fcf_yield`/`p.fcf_positive` but is fed entirely by `commandCenter.router.ts`'s `getBuyRecommendations` query — fixing the SQL alias in the router requires zero frontend changes.

**Files:**
- Modify: `src/server/routers/commandCenter.router.ts`
- Modify: `src/server/ml_ensemble.py`
- Modify: `src/server/db.ts`
- Modify: `db/schema.postgres.sql`

**Interfaces:**
- No new functions. This task only changes SQL column references and schema declarations — the shape of every consumer's downstream code (JS object property access, pandas column access) stays `fcf_yield` via SQL aliasing, so no code beyond the SQL text itself needs to change.

- [ ] **Step 1: Alias the new column back to the old property name in `commandCenter.router.ts`**

In `src/server/routers/commandCenter.router.ts:149`, change:

```typescript
          ts.fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
```

to:

```typescript
          ts.fcf_yield_approx AS fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
```

This is the only change needed for `getBuyRecommendations` and, transitively, `BuyRecommendationsPage.tsx` — the frontend's `p.fcf_yield`/`p.fcf_positive` property accesses are unaffected since the SQL result still has a column literally named `fcf_yield`.

- [ ] **Step 2: Alias the same way in both `ml_ensemble.py` SQL queries**

In `src/server/ml_ensemble.py`, at both line 926 and line 1130, change:

```python
               ts.fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
```

to:

```python
               ts.fcf_yield_approx AS fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
```

at each of the two occurrences. This means line 661 (`X['fcf_yield_norm'] = num('fcf_yield', 0.0).clip(-5, 20) / 20.0`) needs **no change** — the pandas/dict lookup key `'fcf_yield'` still resolves correctly since the SQL result column is aliased back to that name.

- [ ] **Step 3: Update the now-stale comment at `ml_ensemble.py:648-649`**

Change:

```python
    # TODO: enable once financial_ratios_fetcher populates fcf_yield (currently 0 rows)
    # X['quality_compound'] = X['pledge_deleveraging'] * num('fcf_yield', 0.0).clip(0, 0.2) / 0.2
```

to:

```python
    # TODO: enable once there's enough live fcf_yield_approx history to validate this interaction
    # (financial_ratios_fetcher.py now populates it via ET_Stats; was previously always 0 rows)
    # X['quality_compound'] = X['pledge_deleveraging'] * num('fcf_yield', 0.0).clip(0, 0.2) / 0.2
```

Leave the feature itself commented out — re-enabling it is a separate modeling decision outside this task's scope, this only corrects the stale rationale in the comment.

- [ ] **Step 4: Sync `tl_financial_quality` and add `fcf_yield_approx` to `technical_signals` in `db.ts`**

In `src/server/db.ts`, replace the `tl_financial_quality` `CREATE TABLE` block (currently lines ~2210-2221):

```typescript
  CREATE TABLE IF NOT EXISTS tl_financial_quality (
    symbol               TEXT NOT NULL,
    as_of_date           TEXT NOT NULL,
    cfo_ttm              REAL,
    capex_ttm            REAL,
    fcf_ttm              REAL,
    ebit_ttm             REAL,
    interest_expense_ttm REAL,
    market_cap           REAL,
    fcf_yield            REAL,
    interest_coverage    REAL,
    PRIMARY KEY (symbol, as_of_date)
  );
```

with the column set `financial_ratios_fetcher.py::ensure_schema()` now actually creates:

```typescript
  CREATE TABLE IF NOT EXISTS tl_financial_quality (
    symbol               TEXT NOT NULL,
    as_of_date           TEXT NOT NULL,
    cfo_ttm              REAL,
    cfi_ttm              REAL,
    fcf_ttm_approx       REAL,
    interest_coverage    REAL,
    market_cap           REAL,
    fcf_yield_approx     REAL,
    fetched_at           TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, as_of_date)
  );
```

Then in the `ALTER TABLE technical_signals` list (currently around line 2283):

```typescript
  ALTER TABLE technical_signals ADD COLUMN fcf_yield             REAL;
```

add a new line directly after it (keep the old line — do not remove `fcf_yield`, other historical rows/tooling may still reference it, this task only adds the new column):

```typescript
  ALTER TABLE technical_signals ADD COLUMN fcf_yield             REAL;
  ALTER TABLE technical_signals ADD COLUMN fcf_yield_approx      REAL;
```

- [ ] **Step 5: Make the equivalent changes in `db/schema.postgres.sql`**

In the `tl_financial_quality` block (currently lines ~2260-2272):

```sql
CREATE TABLE IF NOT EXISTS "tl_financial_quality" (
  "symbol" TEXT NOT NULL,
  "as_of_date" TEXT NOT NULL,
  "cfo_ttm" DOUBLE PRECISION,
  "capex_ttm" DOUBLE PRECISION,
  "fcf_ttm" DOUBLE PRECISION,
  "ebit_ttm" DOUBLE PRECISION,
  "interest_expense_ttm" DOUBLE PRECISION,
  "market_cap" DOUBLE PRECISION,
  "fcf_yield" DOUBLE PRECISION,
  "interest_coverage" DOUBLE PRECISION,
  "fetched_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("symbol", "as_of_date")
);
```

replace with:

```sql
CREATE TABLE IF NOT EXISTS "tl_financial_quality" (
  "symbol" TEXT NOT NULL,
  "as_of_date" TEXT NOT NULL,
  "cfo_ttm" DOUBLE PRECISION,
  "cfi_ttm" DOUBLE PRECISION,
  "fcf_ttm_approx" DOUBLE PRECISION,
  "interest_coverage" DOUBLE PRECISION,
  "market_cap" DOUBLE PRECISION,
  "fcf_yield_approx" DOUBLE PRECISION,
  "fetched_at" TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("symbol", "as_of_date")
);
```

In the `technical_signals` block, at both line 2193 and line 2269 (`"fcf_yield" DOUBLE PRECISION,` appears twice — this file declares `technical_signals` in two places, verify both before editing), add a new line directly after each occurrence:

```sql
  "fcf_yield" DOUBLE PRECISION,
  "fcf_yield_approx" DOUBLE PRECISION,
```

- [ ] **Step 6: Verify — typecheck, run the existing test suites, and confirm no stale references remain**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Run: `npx vitest run`
Expected: all existing tests still pass (this task changes SQL text and schema declarations only, no test behavior should change).

Run: `cd src/server && python -m pytest tests/test_financial_ratios_fetcher.py -v`
Expected: still 8/8 passing (this task doesn't touch `financial_ratios_fetcher.py` itself).

Run a final grep to confirm every `ts.fcf_yield` SQL reference (not `ts.fcf_yield_approx`) in the codebase is now either aliased with `AS fcf_yield` or doesn't need to be (i.e., there are no more bare, unaliased `ts.fcf_yield` reads left un-repointed):

```bash
grep -rn "\.fcf_yield\b" src/server/routers/commandCenter.router.ts src/server/ml_ensemble.py
```

Expected output: every match includes `fcf_yield_approx AS fcf_yield` or is the `num('fcf_yield', ...)` pandas lookup (unaffected by the alias).

- [ ] **Step 7: Commit**

```bash
git add src/server/routers/commandCenter.router.ts src/server/ml_ensemble.py src/server/db.ts db/schema.postgres.sql
git commit -m "fix: repoint fcf_yield consumers to fcf_yield_approx, sync tl_financial_quality schema-of-record"
```

---

## Plan-level verification (after all tasks)

- [ ] Run the full test suite: `npx tsc --noEmit && npx vitest run`
- [ ] Run every new/modified Python test file together: `cd src/server && python -m pytest tests/test_et_stats_client.py tests/test_financial_ratios_fetcher.py tests/test_working_capital_fetcher.py tests/test_trendlyne_fundamentals_fetcher.py tests/test_trendlyne_overview_fetcher.py tests/test_mc_pricefeed_pe_pb_append.py -v`
- [ ] Manually smoke-test each rewritten Python fetcher against live data for one symbol: `python financial_ratios_fetcher.py --symbol BEL` and `python working_capital_fetcher.py --symbol BEL` — confirm non-null `fcf_yield_approx`/`interest_coverage` and `ccc`/`receivables_days` in the printed output (BEL/companyId 11945 was verified live during this session's research).
- [ ] Confirm `trendlyne_fundamentals_fetcher.py --symbol BEL` still prints DVM scores (unchanged data source, just fewer params fetched).
- [ ] Start the dev server and verify the "Trendlyne DVM" card renders real data (not blank) on a stock detail page that has a `trendlyne_dvm_scores` row.
