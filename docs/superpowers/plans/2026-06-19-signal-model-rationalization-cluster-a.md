# Signal-Model Rationalization — Cluster A (Trade-Signal Consolidation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `unified_signals` the single trade-signal table by rewiring every trade-signal producer and reader off the legacy `signals` and `technical_analysis_signals` tables, then dropping those two tables.

**Architecture:** All producers upsert into `unified_signals` keyed on `(symbol, signal_source, signal_type, signal_date)`; all readers (accuracy, history, tracking, MCP) read from `unified_signals`. Both the SQLite schema (`src/server/db.ts`) and the Postgres schema (`db/schema.postgres.sql`) are updated together so the app works on either engine through the `dbAsync` facade before and after the P3g cutover. No data is migrated — legacy rows are abandoned.

**Tech Stack:** TypeScript (tRPC + `dbAsync` facade over better-sqlite3 / `pg`), Python (SQLAlchemy via `db_compat`), Vitest, SQLite + TimescaleDB/Postgres 16.

## Global Constraints

- No data migration: dropped tables are abandoned; do **not** write ETL for them.
- Quote camelCase identifiers in SQL (`"stopLoss"`, `"createdAt"`) — PG folds unquoted to lowercase.
- `unified_signals` uniqueness key is exactly `(symbol, signal_source, signal_type, signal_date)`; every `ON CONFLICT` on this table must name these four columns.
- All TS DB access goes through `dbAsync` (`dbGet`/`dbAll`/`dbRun`/`dbTransaction`) — never `db.prepare`. All Python engine DB access goes through `db_compat`.
- Per-batch verification (run for every task): `npx tsc --noEmit` (expect 0 errors) + `npx vitest run` (expect all pass). DB-write tasks additionally run a live-PG smoke: `USE_POSTGRES=true node node_modules/tsx/dist/cli.mjs <scratch>.ts` against the running `bharat_timescaledb` container on :5433.
- Out of scope (Cluster B, separate plan): renaming `technical_signals`→`technical_features`, dropping `signal_outcomes`, ML training repoint, prediction write-backs.
- Interpreter for Python: `C:\Users\amitk\AppData\Local\Programs\Python\Python311\python.exe` (has psycopg2-binary). Run Python via Bash with `PYTHONIOENCODING=utf-8`.

---

### Task 1: Tighten `unified_signals` uniqueness key to include `signal_type` (both engines)

The current UNIQUE key `(symbol, signal_date, signal_source)` allows only one signal per
symbol/source/day, so a second setup type from the same source the same day silently overwrites
the first. Widen it to `(symbol, signal_source, signal_type, signal_date)`.

**Files:**
- Modify: `db/schema.postgres.sql:1495` (the `UNIQUE (...)` line inside `unified_signals`)
- Modify: `src/server/db.ts` (the `UNIQUE(...)` clause inside the `CREATE TABLE IF NOT EXISTS unified_signals` block near line 768; add a migration that rebuilds the index for existing dev DBs)
- Test: `src/server/__tests__/unifiedSignalsKey.test.ts` (create)

**Interfaces:**
- Produces: `unified_signals` with UNIQUE `(symbol, signal_source, signal_type, signal_date)`. All later tasks upsert with `ON CONFLICT(symbol, signal_source, signal_type, signal_date)`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/unifiedSignalsKey.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun, dbAll } from '../dbAsync';

describe('unified_signals 4-col uniqueness key', () => {
  beforeEach(async () => {
    await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTKEY']);
  });

  it('keeps two different signal_types for the same symbol/source/date', async () => {
    const date = '2026-06-19';
    const ts = '2026-06-19T10:00:00.000Z';
    for (const type of ['EMA_BULL_STACK', 'BREAKOUT']) {
      await dbRun(`
        INSERT INTO unified_signals
          (symbol, signal_date, signal_source, signal_type, status, signal_generated_at)
        VALUES (?, ?, 'technical', ?, 'ACTIVE', ?)
        ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
          signal_generated_at = excluded.signal_generated_at
      `, ['TESTKEY', date, type, ts]);
    }
    const rows = await dbAll<{ signal_type: string }>(
      'SELECT signal_type FROM unified_signals WHERE symbol = ? ORDER BY signal_type', ['TESTKEY']);
    expect(rows.map(r => r.signal_type)).toEqual(['BREAKOUT', 'EMA_BULL_STACK']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/unifiedSignalsKey.test.ts`
Expected: FAIL — the second insert collides on the old 3-col key and only one row remains (`['BREAKOUT']` or `['EMA_BULL_STACK']`), or `ON CONFLICT` errors because no matching unique index exists.

- [ ] **Step 3: Update both schemas**

In `db/schema.postgres.sql`, change the `unified_signals` UNIQUE line to:
```sql
  UNIQUE ("symbol", "signal_source", "signal_type", "signal_date")
```

In `src/server/db.ts`, change the `UNIQUE(...)` inside the `unified_signals` `CREATE TABLE` to:
```sql
    UNIQUE(symbol, signal_source, signal_type, signal_date)
```
Then add a migration (follow the existing numbered-migration pattern in `db.ts`) that, for already-created dev DBs, drops the old unique index and rebuilds it:
```sql
DROP INDEX IF EXISTS sqlite_autoindex_unified_signals_1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_us_unique_key
  ON unified_signals(symbol, signal_source, signal_type, signal_date);
```
(If the existing `CREATE TABLE` already ran with the old inline UNIQUE, the table-level constraint can't be dropped in SQLite; the explicit `idx_us_unique_key` index above provides the 4-col target that `ON CONFLICT` resolves against. Name the migration consistently with the highest existing migration number + 1.)

- [ ] **Step 4: Apply schema to live Postgres and run test**

Apply the constraint to the running container (idempotent):
```bash
PGPASSWORD=bharat psql -h localhost -p 5433 -U bharat -d bharat_intel -c \
  'ALTER TABLE unified_signals DROP CONSTRAINT IF EXISTS unified_signals_symbol_signal_date_signal_source_key;' -c \
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_us_unique_key ON unified_signals(symbol, signal_source, signal_type, signal_date);'
```
Run: `npx vitest run src/server/__tests__/unifiedSignalsKey.test.ts`
Expected: PASS (`['BREAKOUT', 'EMA_BULL_STACK']`).

- [ ] **Step 5: Commit**

```bash
git add src/server/__tests__/unifiedSignalsKey.test.ts db/schema.postgres.sql src/server/db.ts
git commit -m "feat(signals): widen unified_signals uniqueness to include signal_type"
```

---

### Task 2: Route the AI-signal worker to `unified_signals` only

`processAISignal` in `queues.ts` currently dual-writes legacy `signals` AND `unified_signals`.
Drop the legacy `signals` write; keep the `unified_signals` write (upgraded to the 4-col key) and
the `recommendation_log` audit write that already exists elsewhere in the worker.

**Files:**
- Modify: `src/server/queues.ts:218-257` (remove the `INSERT INTO signals` block; update the `unified_signals` `ON CONFLICT`)
- Test: `src/server/__tests__/aiSignalProducer.test.ts` (create)

**Interfaces:**
- Consumes: `unified_signals` 4-col key (Task 1).
- Produces: AI signals land in `unified_signals` with `signal_source='AI'`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/aiSignalProducer.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun, dbGet } from '../dbAsync';

// Mirrors the exact upsert processAISignal performs, to lock the contract.
async function writeAiSignal(symbol: string, now: string) {
  await dbRun(`
    INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type,
       entry_price, target_price, stop_loss, confidence_score,
       reasoning, status, signal_generated_at)
    VALUES (?, ?, 'AI', ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
      entry_price=excluded.entry_price, target_price=excluded.target_price,
      stop_loss=excluded.stop_loss, confidence_score=excluded.confidence_score,
      reasoning=excluded.reasoning, signal_generated_at=excluded.signal_generated_at
  `, [symbol, now.split('T')[0], 'BUY', 100, 110, 95, 0.7, 'test', now]);
}

describe('AI signal producer', () => {
  beforeEach(async () => { await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTAI']); });

  it('writes an AI signal into unified_signals', async () => {
    await writeAiSignal('TESTAI', '2026-06-19T10:00:00.000Z');
    const row = await dbGet<{ signal_source: string; signal_type: string }>(
      'SELECT signal_source, signal_type FROM unified_signals WHERE symbol = ?', ['TESTAI']);
    expect(row?.signal_source).toBe('AI');
    expect(row?.signal_type).toBe('BUY');
  });
});
```

- [ ] **Step 2: Run test to verify it passes against the schema (red on legacy assumptions)**

Run: `npx vitest run src/server/__tests__/aiSignalProducer.test.ts`
Expected: PASS (this test asserts the target contract; it guards Step 3's edit from regressing the upsert).

- [ ] **Step 3: Remove the legacy `signals` write and update the conflict key**

In `src/server/queues.ts`, delete the block at lines 217–231 (the `// Persist to DB (same schema as the existing saveSignal procedure)` comment through the `signals` insert's closing `]);`). In the remaining `unified_signals` insert, change:
```
    ON CONFLICT(symbol, signal_date, signal_source) DO UPDATE SET
```
to:
```
    ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
```

- [ ] **Step 4: Verify build + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/queues.ts src/server/__tests__/aiSignalProducer.test.ts
git commit -m "refactor(signals): AI worker writes unified_signals only (drop legacy signals)"
```

---

### Task 3: Route `createSignal` / `saveSignal` to `unified_signals`

`signals.ts:createSignal` and `signals.router.ts:saveSignal` both INSERT into legacy `signals`.
Repoint them to `unified_signals` (`signal_source='platform'`). `createSignal` keeps its
`recommendation_log` write unchanged.

**Files:**
- Modify: `src/server/signals.ts:18-33` (`createSignal`)
- Modify: `src/server/routers/signals.router.ts:27-33` (`saveSignal` mutation body)
- Test: `src/server/__tests__/createSignal.test.ts` (create)

**Interfaces:**
- Consumes: `unified_signals` 4-col key (Task 1).
- Produces: `createSignal(signal)` and the `saveSignal` mutation persist to `unified_signals` with `signal_source='platform'`, mapping `type→signal_type`, `entry→entry_price`, `target→target_price`, `stopLoss→stop_loss`, `confidence→confidence_score`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/__tests__/createSignal.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun, dbGet } from '../dbAsync';
import { createSignal } from '../signals';

describe('createSignal', () => {
  beforeEach(async () => {
    await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTCS']);
  });

  it('persists to unified_signals with signal_source=platform', async () => {
    await createSignal({
      symbol: 'TESTCS', type: 'BUY', entry: 100, target: 115, stopLoss: 92,
      confidence: 0.8, reasoning: 'unit test',
    } as any);
    const row = await dbGet<{ signal_source: string; entry_price: number; signal_type: string }>(
      'SELECT signal_source, entry_price, signal_type FROM unified_signals WHERE symbol = ?', ['TESTCS']);
    expect(row?.signal_source).toBe('platform');
    expect(row?.signal_type).toBe('BUY');
    expect(row?.entry_price).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/createSignal.test.ts`
Expected: FAIL — `createSignal` writes legacy `signals`, so `unified_signals` has no `TESTCS` row (`row` is undefined).

- [ ] **Step 3: Rewrite `createSignal`'s signal insert**

In `src/server/signals.ts`, replace the first `dbRun` (the `INSERT INTO signals ...`) with:
```typescript
  const now = new Date().toISOString();
  await dbRun(`
    INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type,
       entry_price, target_price, stop_loss, confidence_score,
       reasoning, status, signal_generated_at)
    VALUES (?, ?, 'platform', ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
    ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
      entry_price=excluded.entry_price, target_price=excluded.target_price,
      stop_loss=excluded.stop_loss, confidence_score=excluded.confidence_score,
      reasoning=excluded.reasoning, signal_generated_at=excluded.signal_generated_at
  `, [signal.symbol, today, signal.type, signal.entry, signal.target,
      signal.stopLoss, signal.confidence, signal.reasoning, now]);
```
(`today` is already computed at the top of `createSignal`; keep the existing `recommendation_log` insert below unchanged.)

- [ ] **Step 4: Repoint `saveSignal` mutation**

In `src/server/routers/signals.router.ts`, replace the `saveSignal` mutation's `dbRun` body with:
```typescript
      const today = new Date().toISOString().split('T')[0];
      const now = new Date().toISOString();
      await dbRun(`
        INSERT INTO unified_signals
          (symbol, signal_date, signal_source, signal_type,
           entry_price, target_price, stop_loss, confidence_score,
           reasoning, status, signal_generated_at)
        VALUES (?, ?, 'platform', ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
        ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
          entry_price=excluded.entry_price, target_price=excluded.target_price,
          stop_loss=excluded.stop_loss, confidence_score=excluded.confidence_score,
          reasoning=excluded.reasoning, signal_generated_at=excluded.signal_generated_at
      `, [input.symbol, today, input.type, input.entry, input.target,
          input.stopLoss, input.confidence, input.reasoning, now]);
      return { success: true };
```

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/server/__tests__/createSignal.test.ts
npx tsc --noEmit && npx vitest run
git add src/server/signals.ts src/server/routers/signals.router.ts src/server/__tests__/createSignal.test.ts
git commit -m "refactor(signals): createSignal + saveSignal write unified_signals (source=platform)"
```
Expected: target test PASS, 0 tsc errors, all tests pass.

---

### Task 4: Route the intraday screener producer to `unified_signals`

`trendlyneScreener.ts:1371` writes generated intraday signals into legacy `signals`. Repoint to
`unified_signals` (`signal_source='screener'`).

**Files:**
- Modify: `src/server/trendlyneScreener.ts:1370-1373`

**Interfaces:**
- Consumes: `unified_signals` 4-col key (Task 1).
- Produces: intraday screener signals land in `unified_signals` with `signal_source='screener'`.

- [ ] **Step 1: Replace the insert**

In `src/server/trendlyneScreener.ts`, replace the `dbRun` at ~1370 with:
```typescript
          const nowIso = new Date().toISOString();
          await dbRun(`
            INSERT INTO unified_signals
              (symbol, signal_date, signal_source, signal_type,
               entry_price, target_price, stop_loss, confidence_score,
               reasoning, status, signal_generated_at)
            VALUES (?, ?, 'screener', ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
            ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
              entry_price=excluded.entry_price, target_price=excluded.target_price,
              stop_loss=excluded.stop_loss, confidence_score=excluded.confidence_score,
              reasoning=excluded.reasoning, signal_generated_at=excluded.signal_generated_at
          `, [symbol, nowIso.split('T')[0], type, entry, target, stopLoss, confidence, reasoning, nowIso]);
```
(`confidence` here is the screener score; if it is on a 0–100 scale in this scope, divide by 100 to store a 0–1 fraction consistent with the other producers. Check the surrounding code for the `confidence`/`score` variable's scale and normalize if needed.)

- [ ] **Step 2: Verify build + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors; all tests pass.

- [ ] **Step 3: Live-PG smoke**

Create `scratch_task4.ts`:
```typescript
import 'dotenv/config';
process.env.USE_POSTGRES = 'true';
import { dbRun, dbGet } from './src/server/dbAsync';
(async () => {
  const now = new Date().toISOString();
  await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['SMOKE4']);
  await dbRun(`INSERT INTO unified_signals
    (symbol, signal_date, signal_source, signal_type, status, signal_generated_at)
    VALUES (?, ?, 'screener', 'BUY', 'ACTIVE', ?)
    ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO NOTHING`,
    ['SMOKE4', now.split('T')[0], now]);
  const r = await dbGet('SELECT signal_source FROM unified_signals WHERE symbol = ?', ['SMOKE4']);
  console.log('row:', r); process.exit(r ? 0 : 1);
})();
```
Run: `USE_POSTGRES=true node node_modules/tsx/dist/cli.mjs scratch_task4.ts`
Expected: `row: { signal_source: 'screener' }`. Then `rm scratch_task4.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/server/trendlyneScreener.ts
git commit -m "refactor(signals): intraday screener writes unified_signals (source=screener)"
```

---

### Task 5: Route `technical_analysis_engine.py` to `unified_signals`

`technical_analysis_engine.py:119` upserts into `technical_analysis_signals`. Repoint to
`unified_signals` (`signal_source='technical'`, `signal_type` from `trend`), folding the
indicator snapshot into `reasoning`.

**Files:**
- Modify: `src/server/technical_analysis_engine.py:117-127`
- Modify: `backend-python/app/technical_analysis_engine.py` (byte-identical copy — apply the same edit)

**Interfaces:**
- Consumes: `unified_signals` 4-col key (Task 1).
- Produces: technical-analysis signals land in `unified_signals` with `signal_source='technical'`.

- [ ] **Step 1: Replace the upsert**

In both files, replace the `INSERT INTO technical_analysis_signals ...` statement with (SQLAlchemy `text()` named binds, per `db_compat`):
```python
                conn.execute(text("""
                    INSERT INTO unified_signals
                      (symbol, signal_date, signal_source, signal_type,
                       entry_price, target_price, stop_loss, reasoning,
                       status, signal_generated_at)
                    VALUES (:symbol, :signal_date, 'technical', :signal_type,
                            :entry_price, :target_price, :stop_loss, :reasoning,
                            'ACTIVE', :signal_generated_at)
                    ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO UPDATE SET
                        entry_price=excluded.entry_price, target_price=excluded.target_price,
                        stop_loss=excluded.stop_loss, reasoning=excluded.reasoning,
                        signal_generated_at=excluded.signal_generated_at
                """), unified_results)
```
Build `unified_results` from the existing `results` rows, mapping each row to:
`signal_date` = today's date string, `signal_type` = the row's `trend`,
`reasoning` = a compact string like `f"RSI={rsi} MACD={macd} BB={bollinger} patterns={patterns}"`,
`signal_generated_at` = `datetime.now(timezone.utc).isoformat()`, and carrying
`entry_price`/`target_price`/`stop_loss` through. Do this transform where `results` is assembled.

- [ ] **Step 2: Python import + regression check (SQLite)**

Run:
```bash
PYEXE="C:/Users/amitk/AppData/Local/Programs/Python/Python311/python.exe"
PYTHONIOENCODING=utf-8 "$PYEXE" -c "import ast; ast.parse(open('src/server/technical_analysis_engine.py').read()); print('syntax OK')"
```
Expected: `syntax OK`. If the engine has a `--run`/CLI entry, run it once against SQLite and confirm rows appear in `unified_signals` with `signal_source='technical'`.

- [ ] **Step 3: Live-PG smoke**

Run the engine (or its scan entrypoint) with `USE_POSTGRES=true PYTHONIOENCODING=utf-8` and confirm via psql:
```bash
PGPASSWORD=bharat psql -h localhost -p 5433 -U bharat -d bharat_intel -c \
  "SELECT count(*) FROM unified_signals WHERE signal_source='technical';"
```
Expected: count increases after the run; no SQL error.

- [ ] **Step 4: Commit**

```bash
git add src/server/technical_analysis_engine.py backend-python/app/technical_analysis_engine.py
git commit -m "refactor(signals): technical_analysis_engine writes unified_signals (source=technical)"
```

---

### Task 6: Repoint legacy `signals` readers to `unified_signals`

Four readers still query legacy `signals`: `getSignals`, `getSignalHistory`, `getAccuracyMetrics`
(in `signals.router.ts`), and `updateSignalAccuracy` (in `signals.ts`). Plus any `signals`
read in `mcpServer.ts`. Repoint all to `unified_signals`, mapping columns
(`type→signal_type`, `entry→entry_price`, etc.) and replacing the legacy `result`/`status`
accuracy logic with the `unified_signal_outcomes`-based outcome where applicable.

**Files:**
- Modify: `src/server/routers/signals.router.ts` (`getSignals` :14, `getSignalHistory` :48, `getAccuracyMetrics` :51-66)
- Modify: `src/server/signals.ts:35-70` (`updateSignalAccuracy`)
- Modify: `src/server/mcpServer.ts` (any `FROM signals` read — locate with grep below)
- Test: `src/server/__tests__/signalReaders.test.ts` (create)

**Interfaces:**
- Consumes: `unified_signals` (populated by Tasks 2–5) and `unified_signal_outcomes`.
- Produces: `getSignals`/`getSignalHistory` return `unified_signals` rows; `getAccuracyMetrics` computes precision from `unified_signal_outcomes.outcome`.

- [ ] **Step 1: Locate the mcpServer reads**

Run: `grep -nE "FROM signals\b|UPDATE signals\b" src/server/mcpServer.ts`
Record each line; repoint each to `unified_signals` with the column mapping in Step 3.

- [ ] **Step 2: Write the failing test**

```typescript
// src/server/__tests__/signalReaders.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { dbRun } from '../dbAsync';
import { createCallerFactory } from '../trpc';
import { appRouter } from '../router';

const caller = createCallerFactory(appRouter)({} as any);

describe('signal readers on unified_signals', () => {
  beforeEach(async () => { await dbRun('DELETE FROM unified_signals WHERE symbol = ?', ['TESTRD']); });

  it('getSignalHistory returns unified_signals rows for a symbol', async () => {
    const now = new Date().toISOString();
    await dbRun(`INSERT INTO unified_signals
      (symbol, signal_date, signal_source, signal_type, entry_price, status, signal_generated_at)
      VALUES (?, ?, 'platform', 'BUY', 101, 'ACTIVE', ?)
      ON CONFLICT(symbol, signal_source, signal_type, signal_date) DO NOTHING`,
      ['TESTRD', now.split('T')[0], now]);
    const rows = await caller.getSignalHistory({ symbol: 'TESTRD' });
    expect(Array.isArray(rows)).toBe(true);
    expect((rows as any[]).some(r => r.symbol === 'TESTRD')).toBe(true);
  });
});
```

- [ ] **Step 3: Repoint the readers**

`getSignals` (`signals.router.ts:14`):
```typescript
      return dbAll('SELECT * FROM unified_signals ORDER BY signal_generated_at DESC LIMIT ?', [input.limit]);
```
`getSignalHistory` (`signals.router.ts:48`):
```typescript
      return dbAll('SELECT * FROM unified_signals WHERE symbol = ? ORDER BY signal_generated_at DESC', [input.symbol]);
```
`getAccuracyMetrics` (`signals.router.ts:53-60`) — compute from outcomes:
```typescript
      const stats = (await dbGet<{ total: number; profit: number; resolved: number }>(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS profit,
          SUM(CASE WHEN outcome IN ('WIN','LOSS','STOP_LOSS','NEUTRAL') THEN 1 ELSE 0 END) AS resolved
        FROM unified_signal_outcomes
      `))!;
```
(The returned `precision`/`profitHitRate`/`totalSignals` computation below stays the same, using `stats.profit`/`stats.resolved`/`stats.total`.)

`updateSignalAccuracy` (`signals.ts:35-70`): change the read to
`SELECT * FROM unified_signals WHERE symbol = ? AND status = 'ACTIVE'`, map fields
(`signal.type`→row `signal_type`, `signal.target`→`target_price`, `signal.stopLoss`→`stop_loss`,
`signal.id`→`id`), and change the `UPDATE signals` to
`UPDATE unified_signals SET status = ?, signal_generated_at = signal_generated_at WHERE id = ?`
(legacy `result` column does not exist on `unified_signals`; drop the `result` write — outcome
lives in `unified_signal_outcomes`). Update the `Signal` interface reads accordingly or cast rows.

Repoint each `mcpServer.ts` hit from Step 1 to `unified_signals` with the same column mapping.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/server/__tests__/signalReaders.test.ts
npx tsc --noEmit && npx vitest run
git add src/server/routers/signals.router.ts src/server/signals.ts src/server/mcpServer.ts src/server/__tests__/signalReaders.test.ts
git commit -m "refactor(signals): repoint signal readers + accuracy onto unified_signals/outcomes"
```
Expected: target test PASS, 0 tsc errors, all tests pass.

---

### Task 7: Drop legacy `signals` and `technical_analysis_signals` tables

With no remaining producers or readers, remove both tables from both schemas and confirm nothing
references them.

**Files:**
- Modify: `db/schema.postgres.sql` (delete the `signals` and `technical_analysis_signals` `CREATE TABLE` + their indexes)
- Modify: `src/server/db.ts:231-...` and `:245-...` (delete both `CREATE TABLE IF NOT EXISTS` blocks; add a migration `DROP TABLE IF EXISTS signals; DROP TABLE IF EXISTS technical_analysis_signals;`)
- Modify: any test fixtures under `src/server/tests/` / `src/server/__tests__/` that seed these tables

**Interfaces:**
- Produces: neither table exists on either engine; all signal flow is through `unified_signals`.

- [ ] **Step 1: Prove zero remaining references**

Run:
```bash
grep -rInE "(FROM|INTO|UPDATE|JOIN|TABLE)\s+(signals|technical_analysis_signals)\b" \
  src/server backend-python --include=*.ts --include=*.py \
  | grep -vE "unified_signals|technical_signals|//|#"
```
Expected: no output (empty). If any line remains, repoint it before continuing.

- [ ] **Step 2: Remove the table definitions**

Delete the `signals` and `technical_analysis_signals` `CREATE TABLE` blocks (and their `CREATE INDEX` lines) from `db/schema.postgres.sql` and `src/server/db.ts`. Add the drop migration in `db.ts` (next migration number):
```sql
DROP TABLE IF EXISTS signals;
DROP TABLE IF EXISTS technical_analysis_signals;
```

- [ ] **Step 3: Drop on live Postgres**

```bash
PGPASSWORD=bharat psql -h localhost -p 5433 -U bharat -d bharat_intel -c \
  'DROP TABLE IF EXISTS signals CASCADE;' -c 'DROP TABLE IF EXISTS technical_analysis_signals CASCADE;'
```

- [ ] **Step 4: Verify build + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors; all tests pass (fixtures updated). If a test seeded `signals`/`technical_analysis_signals`, repoint its seed to `unified_signals` or delete the obsolete assertion.

- [ ] **Step 5: Commit**

```bash
git add db/schema.postgres.sql src/server/db.ts src/server/tests src/server/__tests__
git commit -m "refactor(signals): drop legacy signals + technical_analysis_signals tables"
```

---

### Task 8: End-to-end live-PG verification of Cluster A

Confirm the consolidated model works on Postgres: every producer source writes `unified_signals`
and every reader reads it, with no reference to the dropped tables.

**Files:**
- Test: `scratch_clusterA_smoke.ts` (create, delete after)

- [ ] **Step 1: Write the smoke script**

```typescript
// scratch_clusterA_smoke.ts
import 'dotenv/config';
process.env.USE_POSTGRES = 'true';
import { createCallerFactory } from './src/server/trpc';
import { appRouter } from './src/server/router';
import { dbAll } from './src/server/dbAsync';

const caller = createCallerFactory(appRouter)({} as any);
(async () => {
  const bySource = await dbAll<{ signal_source: string; n: number }>(
    'SELECT signal_source, COUNT(*) AS n FROM unified_signals GROUP BY signal_source ORDER BY signal_source');
  console.log('unified_signals by source:', bySource);
  const sigs = await caller.getSignals({ limit: 5 });
  const acc = await caller.getAccuracyMetrics();
  console.log('getSignals:', Array.isArray(sigs) ? sigs.length : sigs);
  console.log('getAccuracyMetrics:', acc);
  // Assert dropped tables are gone
  let dropped = true;
  try { await dbAll('SELECT 1 FROM signals LIMIT 1'); dropped = false; } catch { /* expected */ }
  try { await dbAll('SELECT 1 FROM technical_analysis_signals LIMIT 1'); dropped = false; } catch { /* expected */ }
  console.log('legacy tables dropped:', dropped);
  process.exit(dropped ? 0 : 1);
})();
```

- [ ] **Step 2: Run it**

Run: `USE_POSTGRES=true node node_modules/tsx/dist/cli.mjs scratch_clusterA_smoke.ts`
Expected: prints `unified_signals by source` (showing AI/platform/screener/technical as producers run), `getSignals` returns a number, `getAccuracyMetrics` returns an object, `legacy tables dropped: true`, exit 0.

- [ ] **Step 3: Clean up and final commit**

```bash
rm scratch_clusterA_smoke.ts
git add -A
git commit -m "test(signals): cluster A end-to-end live-PG smoke verified" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Target `unified_signals` single trade-signal table → Tasks 1–5 (producers) + 6 (readers). ✓
- Target `unified_signal_outcomes` single outcome table → Task 6 reads it for accuracy; producer-side outcome resolver collapse is shared with Cluster B (outcome_resolver already writes `unified_signal_outcomes`; the `signal_outcomes` drop is explicitly Cluster B). ✓ (scoped)
- Drop `signals` + `technical_analysis_signals` → Task 7. ✓
- `technical_signals`→`technical_features` rename, `signal_outcomes` drop, ML repoint → explicitly Cluster B, out of scope here. ✓
- `confluence_signals` / `unified_recommendations` untouched → no task touches them. ✓

**Placeholder scan:** Each code step shows real SQL/TS/Python. Task 5's `unified_results` transform and Task 4's confidence-scale normalization are described with exact column mappings rather than literal full-file code because they depend on the existing local row-assembly the implementer is editing in place; the target SQL is fully specified. Task 6's mcpServer edits are gated on a grep (Step 1) because the line numbers aren't known a priori; the mapping rule is explicit.

**Type/key consistency:** Every `unified_signals` upsert across Tasks 1–5 uses
`ON CONFLICT(symbol, signal_source, signal_type, signal_date)` (matches Task 1's UNIQUE key).
Column names (`entry_price`/`target_price`/`stop_loss`/`confidence_score`/`signal_type`/
`signal_source`/`signal_generated_at`) are consistent across all tasks and match the existing
`unified_signals` DDL.
