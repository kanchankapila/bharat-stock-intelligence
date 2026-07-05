# Trendlyne Checklist Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `fetchTrendlyneChecklist()` (a permanent-null stub since 2026-07-04) using the new `checklist-bypk/{tlid}` endpoint, collected via a slow randomized background sweep across the full `nse_stocks.tlid` universe (~3,022 stocks) rather than on-demand or in one daily burst.

**Architecture:** A pure HTML parser (cheerio) turns the endpoint's server-rendered HTML into the exact shape the (currently dormant) frontend already expects. A self-rescheduling BullMQ job works through the stock universe in random small batches at random intervals, tracking a 7-day-active/30-day-dormant cycle via `app_settings`, and persists results into a new `trendlyne_checklist` table. The on-demand UI path becomes a pure cache read — it never triggers a live fetch.

**Tech Stack:** TypeScript, BullMQ, cheerio (new dependency), Postgres (+ SQLite dev fallback), Vitest.

## Global Constraints

- New tables/columns meant for live Postgres must be added to **all three** of: `src/server/db.ts` (SQLite dev schema), `db/schema.postgres.sql` (fresh-install schema-of-record), and `src/server/pgClient.ts`'s `pgEnsureColumns()` (self-heal for already-provisioned Postgres) — confirmed today's `fcf_yield_approx` incident was caused by missing the third one.
- `fetchTrendlyneChecklist` returns `null` on any failure (network, parse, non-200) — both historical and new consumers rely on this "no data" contract; never throw out of it.
- The on-demand `getTrendlyneChecklist` procedure must never make a live network call — reads the cache table only, per user's explicit direction ("don't rely much on demand").
- `syncTrendlyneScores()`'s existing test (`src/server/__tests__/syncTrendlyneScores.test.ts`) must keep passing unchanged.

---

### Task 1: Checklist HTML parser (pure function, TDD against a real fixture)

**Files:**
- Create: `src/server/trendlyneChecklistParser.ts`
- Create: `src/server/__tests__/fixtures/trendlyne_checklist_sample.html` (already captured — real response for `tlid=175` / Bharat Electronics, 23 questions across 4 categories, verified 17 YES / 6 NO)
- Test: `src/server/__tests__/trendlyneChecklistParser.test.ts`
- Modify: `package.json` (add `cheerio` dependency)

**Interfaces:**
- Produces: `TrendlyneChecklistItem { question: string; answer: boolean }`, `TrendlyneChecklistResult { score: number; total: number; yesCount: number; insight?: string; checklistData: Record<string, TrendlyneChecklistItem[]> }`, `parseChecklistHtml(html: string): TrendlyneChecklistResult | null` — all three tasks below (2, 3) depend on these exact names.

- [ ] **Step 1: Install cheerio**

Run: `npm install cheerio`
Expected: `package.json` gains `"cheerio": "^1.2.0"` (or whatever the installer resolves — confirmed working version is 1.2.0, verified against the real fixture during design).

- [ ] **Step 2: Write the failing test**

The fixture file `src/server/__tests__/fixtures/trendlyne_checklist_sample.html` already exists in the repo (captured live from `https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/175` during design — do not re-fetch it, use the committed copy). Its known-correct values (independently verified with grep and a standalone cheerio script during design): 23 total questions, 17 YES, 6 NO, 4 categories (`Financials`: 8 items all YES; `Ownership`: 4 items all YES; `Peer Comparison`: 3 items, 2 YES; `Value And Momentum`: 8 items, 3 YES).

```typescript
// src/server/__tests__/trendlyneChecklistParser.test.ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseChecklistHtml } from '../trendlyneChecklistParser';

const fixtureHtml = readFileSync(
  join(__dirname, 'fixtures', 'trendlyne_checklist_sample.html'),
  'utf-8',
);

describe('parseChecklistHtml', () => {
  test('parses a real checklist response into the expected shape', () => {
    const result = parseChecklistHtml(fixtureHtml);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(23);
    expect(result!.yesCount).toBe(17);
    expect(result!.score).toBeCloseTo(73.9, 1);
    expect(Object.keys(result!.checklistData).sort()).toEqual(
      ['Financials', 'Ownership', 'Peer Comparison', 'Value And Momentum'].sort(),
    );
    expect(result!.checklistData['Financials']).toHaveLength(8);
    expect(result!.checklistData['Financials'].every(i => i.answer)).toBe(true);
    expect(result!.checklistData['Peer Comparison']).toHaveLength(3);
    expect(result!.checklistData['Peer Comparison'].filter(i => i.answer)).toHaveLength(2);
  });

  test('decodes HTML entities in question text', () => {
    const result = parseChecklistHtml(fixtureHtml);
    const allQuestions = Object.values(result!.checklistData).flat().map(i => i.question);
    expect(allQuestions.some(q => q.includes("Company's sales growth is better"))).toBe(true);
  });

  test('extracts a specific known question correctly', () => {
    const result = parseChecklistHtml(fixtureHtml);
    const item = result!.checklistData['Financials'][0];
    expect(item.question).toBe('Company has seen consistent profit growth in the last eight quarters?');
    expect(item.answer).toBe(true);
  });

  test('returns null for HTML with no checklist content', () => {
    expect(parseChecklistHtml('<div class="tl-checklist"></div>')).toBeNull();
    expect(parseChecklistHtml('<html><body>Not found</body></html>')).toBeNull();
  });
});
```

- [ ] **Step 2b: Copy the fixture into place if not already present**

Verify the file exists (it was captured during design and should already be in the repo):

Run: `ls src/server/__tests__/fixtures/trendlyne_checklist_sample.html`
Expected: file exists, ~595 lines.

If it's missing, re-fetch it:
```bash
mkdir -p src/server/__tests__/fixtures
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" -H "Referer: https://trendlyne.com/" "https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/175" -o src/server/__tests__/fixtures/trendlyne_checklist_sample.html
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/server/__tests__/trendlyneChecklistParser.test.ts`
Expected: FAIL — `Cannot find module '../trendlyneChecklistParser'`

- [ ] **Step 4: Write the parser implementation**

```typescript
// src/server/trendlyneChecklistParser.ts
import * as cheerio from 'cheerio';

export interface TrendlyneChecklistItem {
  question: string;
  answer: boolean;
}

export interface TrendlyneChecklistResult {
  score: number;
  total: number;
  yesCount: number;
  insight?: string;
  checklistData: Record<string, TrendlyneChecklistItem[]>;
}

/**
 * Parses the server-rendered HTML from
 * https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/{tlid}
 * (despite the "clientapi" path segment, this returns HTML, not JSON).
 */
export function parseChecklistHtml(html: string): TrendlyneChecklistResult | null {
  const $ = cheerio.load(html);
  const checklistData: Record<string, TrendlyneChecklistItem[]> = {};
  let yesCount = 0;
  let total = 0;

  $('.checklist-content-header').each((_, headerEl) => {
    const $header = $(headerEl);
    // The category name is the header's own text; strip the nested count-badge
    // span (`.stock-checklist-header`) before reading it.
    const categoryName = $header.clone().find('span').remove().end().text().trim();
    if (!categoryName) return;

    const items: TrendlyneChecklistItem[] = [];
    const $block = $header.parent(); // div.p-y-1.col-xs-12 wrapping this category
    $block.find('.checklist-content-insight').each((_, insightEl) => {
      const $insight = $(insightEl);
      const question = $insight.find('.checklist-content-insight-question').text().trim();
      if (!question) return;
      const answerText = $insight.find('.sprite-checklist-check').text().trim().toUpperCase();
      const answer = answerText.includes('YES');
      items.push({ question, answer });
      total += 1;
      if (answer) yesCount += 1;
    });

    if (items.length > 0) {
      checklistData[categoryName] = items;
    }
  });

  if (total === 0) return null;

  return {
    score: Math.round((yesCount / total) * 1000) / 10,
    total,
    yesCount,
    checklistData,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/server/__tests__/trendlyneChecklistParser.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/trendlyneChecklistParser.ts src/server/__tests__/trendlyneChecklistParser.test.ts src/server/__tests__/fixtures/trendlyne_checklist_sample.html
git commit -m "feat: add Trendlyne checklist HTML parser

Pure parser for the checklist-bypk/{tlid} endpoint response (server-rendered
HTML, not JSON despite the clientapi path). Verified against a real captured
response for tlid=175 (Bharat Electronics): 23 questions across 4 categories,
17 YES / 6 NO."
```

---

### Task 2: `trendlyne_checklist` table in all three schema locations

**Files:**
- Modify: `src/server/db.ts` (append new `db.exec(...)` block near the end, before the "Schema normalization complete" log line)
- Modify: `db/schema.postgres.sql` (append new `CREATE TABLE IF NOT EXISTS` block)
- Modify: `src/server/pgClient.ts` (`pgEnsureColumns()`'s `creates` array)

**Interfaces:**
- Produces: table `trendlyne_checklist(symbol TEXT PRIMARY KEY, score, total, yes_count, insight, checklist_data, fetched_at)` — Task 5's DB glue functions read/write this exact shape.

- [ ] **Step 1: Add the table to `db.ts`**

Find the end of the migration block (search for `console.error('[DB] Schema normalization complete`) and insert a new `db.exec(...)` block immediately before it:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS trendlyne_checklist (
    symbol         TEXT PRIMARY KEY,
    score          REAL,
    total          INTEGER,
    yes_count      INTEGER,
    insight        TEXT,
    checklist_data TEXT,
    fetched_at     DATETIME
  );
`);

```

- [ ] **Step 2: Add the table to `db/schema.postgres.sql`**

Append near the other Trendlyne tables (search for `tl_financial_quality` and add after its closing `);`):

```sql
-- ── trendlyne_checklist ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "trendlyne_checklist" (
  "symbol" TEXT PRIMARY KEY,
  "score" DOUBLE PRECISION,
  "total" BIGINT,
  "yes_count" BIGINT,
  "insight" TEXT,
  "checklist_data" TEXT,
  "fetched_at" TIMESTAMPTZ
);
```

- [ ] **Step 3: Add the table to `pgClient.ts`'s self-heal (the step that was missed for `fcf_yield_approx` today)**

In `pgEnsureColumns()`, add to the `creates` array (alongside `feature_store`, `market_regimes`, etc.):

```typescript
    `CREATE TABLE IF NOT EXISTS trendlyne_checklist (
       symbol TEXT PRIMARY KEY,
       score DOUBLE PRECISION,
       total BIGINT,
       yes_count BIGINT,
       insight TEXT,
       checklist_data TEXT,
       fetched_at TIMESTAMPTZ
     )`,
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts db/schema.postgres.sql src/server/pgClient.ts
git commit -m "feat: add trendlyne_checklist table (SQLite + Postgres schema-of-record + self-heal)"
```

---

### Task 3: Rewrite `fetchTrendlyneChecklist()` for the real endpoint

**Files:**
- Modify: `src/server/trendlyneService.ts`

**Interfaces:**
- Consumes: `parseChecklistHtml` and `TrendlyneChecklistResult` from `./trendlyneChecklistParser` (Task 1).
- Produces: `fetchTrendlyneChecklist(tlid: string): Promise<TrendlyneChecklistResult | null>` — note the parameter is `tlid`, not `symbol` (the only remaining caller, Task 6's cycle job, already has `tlid` resolved from its `nse_stocks` query, so no redundant lookup is needed inside this function).

- [ ] **Step 1: Replace the stub**

Find the existing stub in `src/server/trendlyneService.ts`:

```typescript
export async function fetchTrendlyneChecklist(symbol: string) {
  console.warn(`[TRENDLYNE] Checklist has no JSON API on Trendlyne (only HTML widget scraping); returning null for ${symbol}`);
  return null;
}
```

Replace it with:

```typescript
import { parseChecklistHtml, type TrendlyneChecklistResult } from './trendlyneChecklistParser';

export async function fetchTrendlyneChecklist(tlid: string): Promise<TrendlyneChecklistResult | null> {
  try {
    const res = await fetch(`https://kayal.trendlyne.com/clientapi/kayal/content/checklist-bypk/${tlid}`, {
      headers: {
        ...HEADERS,
        'Referer': 'https://trendlyne.com/',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseChecklistHtml(html);
  } catch (err: any) {
    console.warn(`[TRENDLYNE] Checklist fetch failed for tlid=${tlid}:`, err.message);
    return null;
  }
}
```

(`HEADERS` is the existing `User-Agent`/`Accept` constant already defined near the top of this file — reused here with an added `Referer`, matching the header convention already used by `trendlyne_screener_discovery.py`'s `KAYAL_URL` calls on the same `kayal.trendlyne.com` subdomain.)

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors. (Existing callers — the router and `syncProprietaryScores.ts` — will show type errors here since they still pass `symbol`, not `tlid`; that's expected and gets fixed in Tasks 7-8. If you'd rather keep the build green at every step, do Task 3 together with Tasks 7 and 8 in one sitting before running `tsc`.)

- [ ] **Step 3: Manually verify against the live endpoint**

```bash
node_modules/.bin/tsx.cmd -e "
import('./src/server/trendlyneService.ts').then(async (m) => {
  const r = await m.fetchTrendlyneChecklist('175');
  console.log(JSON.stringify(r, null, 2).slice(0, 500));
});
"
```
Expected: prints a real object with `score: 73.9, total: 23, yesCount: 17, checklistData: {...}` (or whatever BEL's checklist currently shows — Trendlyne data changes over time, so exact numbers may differ from the fixture snapshot).

- [ ] **Step 4: Commit**

```bash
git add src/server/trendlyneService.ts
git commit -m "feat: restore fetchTrendlyneChecklist against the checklist-bypk endpoint

Takes tlid directly now (only remaining caller already has it resolved from
nse_stocks, avoiding a redundant lookup). Preserves the null-on-any-failure
contract both existing consumers rely on."
```

---

### Task 4: Cycle-state pure decision logic (fully unit-testable, no I/O)

**Files:**
- Create: `src/server/trendlyneChecklistCycle.ts` (pure functions only in this task; DB glue functions are added in Task 5 in the same file)
- Test: `src/server/__tests__/trendlyneChecklistCycle.test.ts`

**Interfaces:**
- Produces: `CYCLE_PAUSE_MS`, `DORMANT_RECHECK_MS` (constants), `isDormant(now, cycleCompletedAt): boolean`, `shouldStartNewCycle(cycleStartedAt, cycleCompletedAt, now): boolean`, `pickRandomBatch<T>(items: T[], minSize: number, maxSize: number): T[]`, `randomDelayMs(minMinutes: number, maxMinutes: number): number` — Task 6's queue processor calls all four.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/server/__tests__/trendlyneChecklistCycle.test.ts
import { describe, test, expect } from 'vitest';
import {
  isDormant,
  shouldStartNewCycle,
  pickRandomBatch,
  randomDelayMs,
  CYCLE_PAUSE_MS,
} from '../trendlyneChecklistCycle';

describe('isDormant', () => {
  test('false when no cycle has ever completed', () => {
    expect(isDormant(Date.now(), null)).toBe(false);
  });

  test('true immediately after a cycle completes', () => {
    const now = Date.now();
    expect(isDormant(now, now - 1000)).toBe(true);
  });

  test('true right before the 30-day pause elapses', () => {
    const now = Date.now();
    const completedAt = now - CYCLE_PAUSE_MS + 60_000; // 1 min before pause ends
    expect(isDormant(now, completedAt)).toBe(true);
  });

  test('false once the 30-day pause has elapsed', () => {
    const now = Date.now();
    const completedAt = now - CYCLE_PAUSE_MS - 1000; // 1 sec past pause end
    expect(isDormant(now, completedAt)).toBe(false);
  });
});

describe('shouldStartNewCycle', () => {
  test('true when no cycle has ever started', () => {
    expect(shouldStartNewCycle(null, null, Date.now())).toBe(true);
  });

  test('false mid-cycle (started, not yet completed)', () => {
    const now = Date.now();
    expect(shouldStartNewCycle(now - 1000, null, now)).toBe(false);
  });

  test('false during the dormant pause after completion', () => {
    const now = Date.now();
    expect(shouldStartNewCycle(now - 1_000_000, now - 1000, now)).toBe(false);
  });

  test('true once the 30-day pause has elapsed', () => {
    const now = Date.now();
    const completedAt = now - CYCLE_PAUSE_MS - 1000;
    expect(shouldStartNewCycle(now - 2_000_000, completedAt, now)).toBe(true);
  });
});

describe('pickRandomBatch', () => {
  test('returns a slice within [minSize, maxSize]', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const batch = pickRandomBatch(items, 10, 15);
    expect(batch.length).toBeGreaterThanOrEqual(10);
    expect(batch.length).toBeLessThanOrEqual(15);
  });

  test('never returns more items than available', () => {
    const items = [1, 2, 3];
    const batch = pickRandomBatch(items, 10, 15);
    expect(batch.length).toBeLessThanOrEqual(3);
  });

  test('only returns items present in the input, no duplicates', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const batch = pickRandomBatch(items, 10, 15);
    expect(new Set(batch).size).toBe(batch.length);
    for (const x of batch) expect(items).toContain(x);
  });
});

describe('randomDelayMs', () => {
  test('returns a value within [min, max] minutes converted to ms', () => {
    const ms = randomDelayMs(15, 45);
    expect(ms).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(45 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/server/__tests__/trendlyneChecklistCycle.test.ts`
Expected: FAIL — `Cannot find module '../trendlyneChecklistCycle'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/server/trendlyneChecklistCycle.ts

export const CYCLE_PAUSE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DORMANT_RECHECK_MS = 24 * 60 * 60 * 1000;  // 1 day

/** True while the 30-day pause after a completed cycle hasn't elapsed yet. */
export function isDormant(now: number, cycleCompletedAt: number | null): boolean {
  return cycleCompletedAt !== null && now < cycleCompletedAt + CYCLE_PAUSE_MS;
}

/** True when a fresh 7-day cycle should begin: never started, or the previous
 *  cycle's 30-day pause has fully elapsed. */
export function shouldStartNewCycle(
  cycleStartedAt: number | null,
  cycleCompletedAt: number | null,
  now: number,
): boolean {
  if (cycleStartedAt === null) return true;
  if (cycleCompletedAt !== null && now >= cycleCompletedAt + CYCLE_PAUSE_MS) return true;
  return false;
}

/** Random contiguous-order-independent sample sized between minSize and maxSize
 *  (clamped to the input length). Used to pick this run's stock batch. */
export function pickRandomBatch<T>(items: T[], minSize: number, maxSize: number): T[] {
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  const size = Math.min(
    items.length,
    minSize + Math.floor(Math.random() * (maxSize - minSize + 1)),
  );
  return shuffled.slice(0, size);
}

/** Random delay in ms, uniformly distributed between minMinutes and maxMinutes. */
export function randomDelayMs(minMinutes: number, maxMinutes: number): number {
  const minutes = minMinutes + Math.random() * (maxMinutes - minMinutes);
  return Math.round(minutes * 60 * 1000);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/server/__tests__/trendlyneChecklistCycle.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/trendlyneChecklistCycle.ts src/server/__tests__/trendlyneChecklistCycle.test.ts
git commit -m "feat: add pure cycle-state decision logic for checklist background sweep"
```

---

### Task 5: DB glue functions for the cycle (state + pending stocks + upsert)

**Files:**
- Modify: `src/server/trendlyneChecklistCycle.ts` (append to the same file — these functions are the impure counterpart to Task 4's pure logic, kept together since they're small and tightly related)

**Interfaces:**
- Consumes: `dbGet`, `dbAll`, `dbRun` from `./dbAsync`; `TrendlyneChecklistResult` from `./trendlyneChecklistParser` (Task 1).
- Produces: `CycleState { cycleStartedAt: number | null; cycleCompletedAt: number | null }`, `getCycleState(): Promise<CycleState>`, `startNewCycle(now: number): Promise<void>`, `completeCycle(now: number): Promise<void>`, `PendingStock { symbol: string; tlid: string }`, `getPendingStocksForCycle(cycleStartedAt: number): Promise<PendingStock[]>`, `upsertChecklistResult(symbol: string, result: TrendlyneChecklistResult, fetchedAt: number): Promise<void>` — all six consumed by Task 6's queue processor.

- [ ] **Step 1: Append the DB glue functions**

Add to the bottom of `src/server/trendlyneChecklistCycle.ts`:

```typescript
import { dbGet, dbAll, dbRun } from './dbAsync';
import type { TrendlyneChecklistResult } from './trendlyneChecklistParser';

export interface CycleState {
  cycleStartedAt: number | null;
  cycleCompletedAt: number | null;
}

const STARTED_KEY = 'trendlyne_checklist_cycle_started_at';
const COMPLETED_KEY = 'trendlyne_checklist_cycle_completed_at';

export async function getCycleState(): Promise<CycleState> {
  const startRow = await dbGet<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?', [STARTED_KEY],
  );
  const completeRow = await dbGet<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?', [COMPLETED_KEY],
  );
  return {
    cycleStartedAt: startRow?.value ? Number(startRow.value) : null,
    cycleCompletedAt: completeRow?.value ? Number(completeRow.value) : null,
  };
}

async function upsertAppSetting(key: string, value: string): Promise<void> {
  await dbRun(
    'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, value],
  );
}

export async function startNewCycle(now: number): Promise<void> {
  await upsertAppSetting(STARTED_KEY, String(now));
  await upsertAppSetting(COMPLETED_KEY, '');
}

export async function completeCycle(now: number): Promise<void> {
  await upsertAppSetting(COMPLETED_KEY, String(now));
}

export interface PendingStock {
  symbol: string;
  tlid: string;
}

export async function getPendingStocksForCycle(cycleStartedAt: number): Promise<PendingStock[]> {
  return dbAll<PendingStock>(
    `SELECT n.symbol, n.tlid FROM nse_stocks n
     WHERE n.tlid IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM trendlyne_checklist c
         WHERE c.symbol = n.symbol AND c.fetched_at >= ?
       )`,
    [new Date(cycleStartedAt).toISOString()],
  );
}

export async function upsertChecklistResult(
  symbol: string,
  result: TrendlyneChecklistResult,
  fetchedAt: number,
): Promise<void> {
  await dbRun(
    `INSERT INTO trendlyne_checklist (symbol, score, total, yes_count, insight, checklist_data, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       score = excluded.score, total = excluded.total, yes_count = excluded.yes_count,
       insight = excluded.insight, checklist_data = excluded.checklist_data, fetched_at = excluded.fetched_at`,
    [
      symbol,
      result.score,
      result.total,
      result.yesCount,
      result.insight ?? null,
      JSON.stringify(result.checklistData),
      new Date(fetchedAt).toISOString(),
    ],
  );
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify against the live dev database**

```bash
node_modules/.bin/tsx.cmd -e "
import 'dotenv/config';
import('./src/server/trendlyneChecklistCycle.ts').then(async (m) => {
  console.log('cycle state:', await m.getCycleState());
  await m.startNewCycle(Date.now());
  console.log('after start:', await m.getCycleState());
  const pending = await m.getPendingStocksForCycle(Date.now());
  console.log('pending count:', pending.length, 'sample:', pending.slice(0, 3));
});
"
```
Expected: prints cycle state (null/null initially), then a timestamp after starting, then a pending count close to the number of `nse_stocks` rows with a non-null `tlid` (~3,022) and a sample of `{symbol, tlid}` pairs.

- [ ] **Step 4: Commit**

```bash
git add src/server/trendlyneChecklistCycle.ts
git commit -m "feat: add DB glue for checklist cycle state, pending-stock query, and upsert"
```

---

### Task 6: BullMQ self-rescheduling queue

**Files:**
- Modify: `src/server/queues.ts`

**Interfaces:**
- Consumes: `isDormant`, `shouldStartNewCycle`, `pickRandomBatch`, `randomDelayMs`, `DORMANT_RECHECK_MS`, `getCycleState`, `startNewCycle`, `completeCycle`, `getPendingStocksForCycle`, `upsertChecklistResult` from `./trendlyneChecklistCycle` (Tasks 4-5); `fetchTrendlyneChecklist` from `./trendlyneService` (Task 3).

- [ ] **Step 1: Add the import**

Near the top of `queues.ts`, alongside the other Trendlyne-related imports:

```typescript
import {
  isDormant, shouldStartNewCycle, pickRandomBatch, randomDelayMs, DORMANT_RECHECK_MS,
  getCycleState, startNewCycle, completeCycle, getPendingStocksForCycle, upsertChecklistResult,
} from './trendlyneChecklistCycle';
import { fetchTrendlyneChecklist } from './trendlyneService';
```

- [ ] **Step 2: Add the queue name constant and module-level queue/worker variables**

Near the other `export const QUEUE_*` constants:

```typescript
export const QUEUE_TRENDLYNE_CHECKLIST_CYCLE = 'trendlyne-checklist-cycle';
```

Near the other `let ...Queue: Queue | null = null;` / `let ...Worker: Worker | null = null;` declarations:

```typescript
let trendlyneChecklistCycleQueue: Queue | null = null;
let trendlyneChecklistCycleWorker: Worker | null = null;
```

- [ ] **Step 3: Add the processor function**

Add near the other `processX` functions (e.g. near `processMlDailyOps`):

```typescript
async function processTrendlyneChecklistCycle(_job: Job): Promise<void> {
  const queue = trendlyneChecklistCycleQueue!;
  let nextDelayMs = randomDelayMs(15, 45);
  try {
    const now = Date.now();
    let { cycleStartedAt, cycleCompletedAt } = await getCycleState();

    if (isDormant(now, cycleCompletedAt)) {
      nextDelayMs = DORMANT_RECHECK_MS;
      return;
    }

    if (shouldStartNewCycle(cycleStartedAt, cycleCompletedAt, now)) {
      await startNewCycle(now);
      cycleStartedAt = now;
    }

    const pending = await getPendingStocksForCycle(cycleStartedAt!);

    if (pending.length === 0) {
      await completeCycle(now);
      nextDelayMs = DORMANT_RECHECK_MS;
      return;
    }

    const batch = pickRandomBatch(pending, 10, 15);
    for (const stock of batch) {
      try {
        const result = await fetchTrendlyneChecklist(stock.tlid);
        if (result) {
          await upsertChecklistResult(stock.symbol, result, Date.now());
        }
      } catch (e: any) {
        console.warn(`[TRENDLYNE-CHECKLIST] Failed for ${stock.symbol}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    }

    console.log(`[TRENDLYNE-CHECKLIST] Processed ${batch.length} stocks this run.`);
  } finally {
    await queue.add('checklist-cycle-tick', {}, { delay: nextDelayMs });
  }
}
```

- [ ] **Step 4: Wire up the queue and worker in `initQueues()`**

Add near the end of `initQueues()`, after the other queue/worker setups, using the module's existing `connection` variable:

```typescript
  // ── Trendlyne Checklist Cycle (self-rescheduling, random interval) ──────────
  trendlyneChecklistCycleQueue = new Queue(QUEUE_TRENDLYNE_CHECKLIST_CYCLE, { connection });
  trendlyneChecklistCycleWorker = new Worker(
    QUEUE_TRENDLYNE_CHECKLIST_CYCLE,
    processTrendlyneChecklistCycle,
    { connection, concurrency: 1, lockDuration: 5 * 60 * 1000 },
  );
  trendlyneChecklistCycleWorker.on('failed', (_job, err) => {
    console.error('[QUEUE] trendlyne-checklist-cycle failed:', err.message);
  });

  // Only kick off the self-rescheduling chain if one isn't already pending —
  // otherwise every dev restart (tsx watch) spawns a duplicate chain.
  const pendingChecklistJobs =
    (await trendlyneChecklistCycleQueue.getWaitingCount()) +
    (await trendlyneChecklistCycleQueue.getDelayedCount()) +
    (await trendlyneChecklistCycleQueue.getActiveCount());
  if (pendingChecklistJobs === 0) {
    await trendlyneChecklistCycleQueue.add('checklist-cycle-tick', {}, { delay: 60_000 });
  }
  console.log('[QUEUE] Trendlyne checklist cycle scheduled (random 15-45 min intervals)');
```

- [ ] **Step 5: Add to the shutdown/close block**

Find the `Promise.all([...])` (or similar) block in the graceful-shutdown function that closes all queues/workers, and add:

```typescript
    trendlyneChecklistCycleWorker?.close(),
    trendlyneChecklistCycleQueue?.close(),
```

- [ ] **Step 6: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manually verify end-to-end with the dev server**

Start the dev server (`npm run dev`), watch the logs for:
```
[QUEUE] Trendlyne checklist cycle scheduled (random 15-45 min intervals)
```
Then wait ~60s for the first tick and confirm a log line like:
```
[TRENDLYNE-CHECKLIST] Processed N stocks this run.
```
Query the DB to confirm rows landed: `SELECT COUNT(*) FROM trendlyne_checklist;` should be > 0.

- [ ] **Step 8: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: wire up self-rescheduling trendlyne-checklist-cycle BullMQ queue

Random 15-45 min intervals (true random, not fixed cadence — BullMQ's repeat
only supports fixed schedules), 10-15 random stocks per run, 7-day active
cycle + 30-day dormant pause tracked via app_settings."
```

---

### Task 7: On-demand router reads from cache only

**Files:**
- Modify: `src/server/routers/trendlyne.router.ts`

- [ ] **Step 1: Replace the live-fetch call with a DB read**

Find the `getTrendlyneChecklist` procedure (currently calling `fetchTrendlyneChecklist(input.symbol)`) and replace its handler:

```typescript
  getTrendlyneChecklist: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const row = await dbGet<{
        score: number; total: number; yes_count: number;
        insight: string | null; checklist_data: string;
      }>(
        'SELECT score, total, yes_count, insight, checklist_data FROM trendlyne_checklist WHERE symbol = ?',
        [input.symbol],
      );
      if (!row) return null;
      return {
        score: row.score,
        total: row.total,
        yesCount: row.yes_count,
        insight: row.insight ?? undefined,
        checklistData: JSON.parse(row.checklist_data),
      };
    }),
```

(Add `dbGet` to this file's imports from `../dbAsync` if not already imported; remove the now-unused import of `fetchTrendlyneChecklist` from `../trendlyneService` if this was the only call site in this file.)

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify via the live server**

```bash
curl -s -X POST http://localhost:3000/api/trpc/getTrendlyneChecklist -H "Content-Type: application/json" -d '{"symbol":"BEL"}'
```
Expected (once the cycle job has processed BEL — check with `SELECT * FROM trendlyne_checklist WHERE symbol='BEL'` first if this returns `null`): a JSON object matching the shape from Task 1, or `null` if BEL hasn't been reached by the cycle yet.

- [ ] **Step 4: Commit**

```bash
git add src/server/routers/trendlyne.router.ts
git commit -m "feat: getTrendlyneChecklist reads from cache only, never live-fetches

Per user direction: all Trendlyne checklist traffic funnels through the
paced background cycle job; viewing a stock's info panel never triggers
a live request."
```

---

### Task 8: Remove checklist from the daily DVM sync

**Files:**
- Modify: `src/server/syncProprietaryScores.ts`

- [ ] **Step 1: Remove the checklist call and branch**

In `syncTrendlyneScores()`, change:

```typescript
      const [dvm, checklist] = await Promise.all([
        getTrendlyneDVMFromDb(stock.symbol),
        fetchTrendlyneChecklist(stock.symbol),
      ]);

      if (!dvm && !checklist) {
        continue;
      }
```

to:

```typescript
      const dvm = await getTrendlyneDVMFromDb(stock.symbol);

      if (!dvm) {
        continue;
      }
```

And remove this block entirely:

```typescript
      if (checklist && (checklist as any).score !== undefined) {
        stockUpserts.push([stock.symbol, date, 'checklist', (checklist as any).score, (checklist as any).insight || '']);
      }
```

Remove the now-unused `fetchTrendlyneChecklist` import from this file, and update the comment above the old `Promise.all` (previously: `"DVM comes from trendlyne_dvm_scores (no live request) — checklist still has no surviving data source, kept as a probe so this self-heals if it's ever restored."`) to:

```typescript
      // DVM comes from trendlyne_dvm_scores (no live request). Checklist now has
      // its own dedicated pipeline (trendlyne-checklist-cycle queue, see queues.ts) —
      // running it here too would create a second, uncontrolled 3,000-request burst
      // once a day, defeating the whole point of pacing it.
```

- [ ] **Step 2: Run the existing test suite for this file**

Run: `npx vitest run src/server/__tests__/syncTrendlyneScores.test.ts`
Expected: PASS (2 tests, unchanged — this test only ever asserted DVM behavior).

- [ ] **Step 3: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/syncProprietaryScores.ts
git commit -m "refactor: remove checklist from syncTrendlyneScores, now owned by its own cycle job

Leaving it in the daily DVM sync would create a second, uncontrolled
~3,000-stock burst once a day alongside the new paced background job."
```

---

## Final verification

- [ ] Run the full test suite: `npx vitest run`
  Expected: all tests pass, including the 4 new parser tests, 10 new cycle-logic tests, and the 2 unchanged `syncTrendlyneScores` tests.
- [ ] Run the full type check: `npx tsc --noEmit`
  Expected: no errors.
- [ ] Start the dev server and confirm in the logs: `[QUEUE] Trendlyne checklist cycle scheduled`, then after ~60s a `[TRENDLYNE-CHECKLIST] Processed N stocks this run.` line, then confirm `SELECT COUNT(*) FROM trendlyne_checklist` is growing over subsequent ticks.
- [ ] Open a stock's info panel in the browser for a symbol already present in `trendlyne_checklist` (query the table to find one) and confirm the "Trendlyne Checklist" card renders with real categories/questions instead of being empty.
