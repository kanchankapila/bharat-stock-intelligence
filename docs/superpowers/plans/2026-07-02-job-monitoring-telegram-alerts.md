# Job Pipeline Monitoring + Telegram Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every scheduled job pipeline (BullMQ queues + the Python engines already tracked by `MONITOR_SCRIPTS`) reports its health, and a Telegram alert fires the moment a critical job is later than its usual completion time with no success yet today, plus a 9 PM IST daily digest of all jobs.

**Architecture:** Reuse the two tracking mechanisms that already exist instead of building a third: `MONITOR_SCRIPTS`/`getSystemStatus()` in `monitor.router.ts` (real DB-freshness checks, 20 Python-engine entries) for jobs it already covers, and the existing `job_heartbeat` table (`jobHeartbeat.ts`) extended with cron-aware lateness math for the ~30 pure-BullMQ queues it doesn't. A new `jobWatchdog.ts` reads both sources on a 15-minute timer and fires Telegram via the already-working `telegramService.sendMarkdownMessage`; a new daily BullMQ job sends the 9 PM IST digest.

**Tech Stack:** TypeScript, BullMQ, `cron-parser` (already a direct dependency, already used in `queues.ts`'s `addJobWithCatchup`), Vitest, existing `dbAsync` (SQLite/Postgres facade), existing `telegramService.ts`.

## Global Constraints

- All cron lateness math MUST pass `{ tz: 'Etc/UTC' }` to `CronExpressionParser.parse()` — every pattern in `queues.ts` is already expressed in UTC (its IST-time is only in a comment), and `addJobWithCatchup` already forces `opts.repeat.tz = 'Etc/UTC'` when unset. Omitting `tz` makes `cron-parser` use the host's local timezone and silently double-shifts the "expected fire time" (verified during planning: on this dev machine, omitting `tz` shifted a UTC-intended pattern by 5.5 hours).
- `recordHeartbeat()` must never throw into a caller — it already wraps its body in try/catch; new code added to it (columns, `getLateJobs`) must preserve that.
- No new UI/tRPC endpoint — Telegram is the only delivery channel for this plan (per approved design, non-goals section).
- Do not touch the Python engine schedules/logic themselves, or `MONITOR_SCRIPTS` entries — only read from `getSystemStatus()`.
- Every task ends green on `npx tsc --noEmit` and `npx vitest run` before its commit.

---

## Task 1: `jobRegistry.ts` — pure-BullMQ job schedule table

**Files:**
- Create: `src/server/jobRegistry.ts`
- Test: `src/server/__tests__/jobRegistry.test.ts`

**Interfaces:**
- Produces: `interface JobScheduleEntry { jobName: string; label: string; cronPattern?: string; everyMs?: number; graceMinutes: number; critical: boolean }` and `export const JOB_REGISTRY: JobScheduleEntry[]`.
- Consumed by: Task 2 (`getLateJobs`), Task 9 (`jobWatchdog`).

This table covers only the queues **not** already tracked by `MONITOR_SCRIPTS` in
`monitor.router.ts` (that registry's `queueName` field already covers: `technical-signals`,
`outcome-resolver`, `ml-daily-ops`, `ml-weekly-retrain`, `ohlcv-backfill`,
`screener-performance`, `company-profiles-sync` — do not duplicate those here).

- [ ] **Step 1: Write the failing test**

```ts
// src/server/__tests__/jobRegistry.test.ts
import { describe, it, expect } from 'vitest';
import { JOB_REGISTRY } from '../jobRegistry';
import { CronExpressionParser } from 'cron-parser';

describe('JOB_REGISTRY', () => {
  it('has no duplicate job names', () => {
    const names = JOB_REGISTRY.map(j => j.jobName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every scheduled (non-event-driven) entry has a parseable cron or everyMs', () => {
    for (const j of JOB_REGISTRY) {
      if (j.cronPattern === undefined && j.everyMs === undefined) continue; // event-driven, allowed
      if (j.cronPattern) {
        expect(() => CronExpressionParser.parse(j.cronPattern!, { tz: 'Etc/UTC' })).not.toThrow();
      } else {
        expect(j.everyMs).toBeGreaterThan(0);
      }
      expect(j.graceMinutes).toBeGreaterThan(0);
    }
  });

  it('marks event-driven jobs (ai-signals, dl-retrain-emergency) with no schedule', () => {
    const aiSignals = JOB_REGISTRY.find(j => j.jobName === 'ai-signals');
    const dlEmergency = JOB_REGISTRY.find(j => j.jobName === 'dl-retrain-emergency');
    expect(aiSignals?.cronPattern).toBeUndefined();
    expect(aiSignals?.everyMs).toBeUndefined();
    expect(dlEmergency?.cronPattern).toBeUndefined();
    expect(dlEmergency?.everyMs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/jobRegistry.test.ts`
Expected: FAIL with "Cannot find module '../jobRegistry'"

- [ ] **Step 3: Write the registry**

```ts
// src/server/jobRegistry.ts
/**
 * Schedule metadata for the pure-BullMQ queues NOT already covered by
 * MONITOR_SCRIPTS (monitor.router.ts) — that registry's queueName field
 * covers technical-signals, outcome-resolver, ml-daily-ops, ml-weekly-retrain,
 * ohlcv-backfill, screener-performance, company-profiles-sync already, with
 * real DB-freshness checks. Do not duplicate those here.
 *
 * cronPattern values are copied verbatim from queues.ts `repeat: { pattern }`
 * configs and MUST be evaluated with `{ tz: 'Etc/UTC' }` (see Global Constraints
 * in the implementation plan) — addJobWithCatchup already forces that tz when
 * registering the repeatable job, so this must match to compute the same
 * "expected fire time".
 */
export interface JobScheduleEntry {
  jobName: string;
  label: string;
  cronPattern?: string;   // undefined + everyMs undefined = event-driven, no lateness check
  everyMs?: number;
  graceMinutes: number;
  critical: boolean;
}

export const JOB_REGISTRY: JobScheduleEntry[] = [
  { jobName: 'stock-refresh', label: 'Stock Price Refresh', cronPattern: '30 10 * * 1-5', graceMinutes: 30, critical: true },
  { jobName: 'ai-signals', label: 'AI Signal Analyzer', graceMinutes: 0, critical: false },
  { jobName: 'stock-scoring', label: 'Stock Scoring Sync', cronPattern: '0 13 * * 1-5', graceMinutes: 60, critical: true },
  { jobName: 'mc-screener-sync', label: 'MoneyControl Screener Sync', cronPattern: '30 17 * * 1-5', graceMinutes: 60, critical: true },
  { jobName: 'etnow-screener-sync', label: 'ETNow Screener Sync', cronPattern: '0 18 * * 1-5', graceMinutes: 90, critical: true },
  { jobName: 'nse-sync', label: 'NSE Master List Sync', cronPattern: '0 2 * * 0', graceMinutes: 120, critical: false },
  { jobName: 'fundamentals-sync', label: 'Fundamentals Sync', cronPattern: '0 22 * * 0', graceMinutes: 120, critical: false },
  { jobName: 'quant-scoring', label: 'Quant Score Engine', cronPattern: '30 13 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'signal-outcomes', label: 'Signal Outcome Tracker', cronPattern: '30 3 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'news-sentiment', label: 'News Sentiment Refresh', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: true },
  { jobName: 'trendlyne-intraday', label: 'Trendlyne Intraday Scan', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: false },
  { jobName: 'outcome-resolver', label: 'Outcome Resolver', cronPattern: '0 4 * * 1-5', graceMinutes: 60, critical: true },
  { jobName: 'intraday-fetcher', label: 'Intraday Bar Fetcher', cronPattern: '*/30 3-10 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'research-premarket', label: 'Premarket Research', cronPattern: '0 3 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'research-postclose', label: 'Postclose Research', cronPattern: '45 10 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'dl-macro-fetch', label: 'DL Macro Fetcher', cronPattern: '30 2 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'preopen-snapshot', label: 'Preopen Snapshot', cronPattern: '40 3 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'market-regime-refresh', label: 'Market Regime Refresh (intraday)', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false },
  { jobName: 'dl-feature-refresh', label: 'DL Feature Refresh', cronPattern: '0 10 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'dl-inference', label: 'DL Model Inference', cronPattern: '0 17 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'dl-regime-update', label: 'HMM Regime Update', cronPattern: '15 11 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'dl-retrain-emergency', label: 'DL Emergency Retrain (drift-triggered)', graceMinutes: 0, critical: false },
  { jobName: 'confluence-compute', label: 'Confluence Engine', everyMs: 30 * 60 * 1000, graceMinutes: 45, critical: true },
  { jobName: 'confluence-outcomes', label: 'Confluence Outcomes', cronPattern: '30 17 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-data-scientist', label: 'Agent: Data Scientist', cronPattern: '30 1 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-strategist', label: 'Agent: Strategist', cronPattern: '0 3 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-auditor', label: 'Agent: Auditor', cronPattern: '0 11 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'agent-optimizer', label: 'Agent: Optimizer', cronPattern: '0 12 * * 1-5', graceMinutes: 60, critical: false },
  { jobName: 'unified-ranker', label: 'Unified Daily Ranker', cronPattern: '15 10 * * 1-5', graceMinutes: 45, critical: true },
  { jobName: 'live-screener-collect', label: 'Live Screener Poller', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 30, critical: false },
  { jobName: 'quant-eod-sync', label: 'Quant EOD Sync', cronPattern: '30 12 * * 1-5', graceMinutes: 45, critical: false },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/jobRegistry.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add src/server/jobRegistry.ts src/server/__tests__/jobRegistry.test.ts
git commit -m "feat: add pure-BullMQ job schedule registry for lateness detection"
```

---

## Task 2: `jobHeartbeat.ts` — cron-aware lateness detection

**Files:**
- Modify: `src/server/jobHeartbeat.ts`
- Test: `src/server/__tests__/jobHeartbeat.test.ts` (new)

**Interfaces:**
- Consumes: `JOB_REGISTRY` / `JobScheduleEntry` from Task 1 (`../jobRegistry`).
- Produces: `export async function getLateJobs(now?: Date): Promise<Array<{ job: string; label: string; expectedAt: Date; hoursLate: number; lastError: string | null }>>` and `export async function markAlerted(jobName: string, occurrenceEpochMs: number): Promise<void>`. Both consumed by Task 9 (`jobWatchdog.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// src/server/__tests__/jobHeartbeat.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRows: any[] = [];
vi.mock('../dbAsync', () => ({
  dbAll: vi.fn(async () => mockRows),
  dbRun: vi.fn(async () => {}),
  dbExec: vi.fn(async () => {}),
}));
vi.mock('../jobRegistry', () => ({
  JOB_REGISTRY: [
    { jobName: 'daily-job', label: 'Daily Job', cronPattern: '0 10 * * 1-5', graceMinutes: 60, critical: true },
    { jobName: 'event-job', label: 'Event Job', graceMinutes: 0, critical: false },
  ],
}));

import { getLateJobs } from '../jobHeartbeat';

describe('getLateJobs', () => {
  beforeEach(() => { mockRows.length = 0; });

  it('flags a job whose last success predates today\'s expected fire time plus grace', async () => {
    // 'daily-job' fires 10:00 UTC weekdays; "now" is Thu 2026-07-02T12:00:00Z (2h after fire+60min grace)
    const now = new Date('2026-07-02T12:00:00Z');
    mockRows.push({ job_name: 'daily-job', last_success_at: new Date('2026-07-01T10:05:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).toContain('daily-job');
  });

  it('does not flag a job that already succeeded after today\'s fire time', async () => {
    const now = new Date('2026-07-02T12:00:00Z');
    mockRows.push({ job_name: 'daily-job', last_success_at: new Date('2026-07-02T10:02:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).not.toContain('daily-job');
  });

  it('does not flag before the grace period has elapsed', async () => {
    // fire time 10:00 UTC, grace 60 min -> not late until 11:00 UTC
    const now = new Date('2026-07-02T10:30:00Z');
    mockRows.push({ job_name: 'daily-job', last_success_at: new Date('2026-07-01T10:05:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).not.toContain('daily-job');
  });

  it('skips event-driven jobs entirely', async () => {
    const now = new Date('2026-07-02T12:00:00Z');
    mockRows.push({ job_name: 'event-job', last_success_at: null, last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).not.toContain('event-job');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/jobHeartbeat.test.ts`
Expected: FAIL — `getLateJobs` either doesn't exist yet or uses the old flat-hour logic (existing `getStaleJobs` ignores cron entirely, so the "does not flag before grace elapsed" case would fail against the old function if aliased).

- [ ] **Step 3: Implement `getLateJobs` + `markAlerted`**

Replace the whole file `src/server/jobHeartbeat.ts` with:

```ts
/**
 * Job heartbeat & staleness monitor
 * =================================
 * Records the last run / last success of each scheduled queue and warns when a job
 * has not succeeded within its expected window. This is the safety net for the class
 * of bug that silently broke the outcome-resolution loop: a worker that fails (or never
 * runs) used to leave no trace. Now staleness is visible and queryable.
 *
 * Timestamps are stored as epoch-ms integers to avoid SQLite/JS timezone parsing pitfalls.
 */
import { dbAll, dbRun, dbExec } from './dbAsync';
import { CronExpressionParser } from 'cron-parser';
import { JOB_REGISTRY } from './jobRegistry';

// This module is the sole creator of job_heartbeat on both engines (it is not in db.ts
// nor the generated PG schema). The CREATE runs once, memoized, and every public fn
// awaits it before its first query — so there is no create-vs-query race now that the
// data layer is async.
// last_run_at / last_success_at / last_alert_sent_at hold epoch-ms (~1.7e12) which
// overflows Postgres' 32-bit INTEGER — use BIGINT (SQLite treats BIGINT as 64-bit
// INTEGER affinity, so the same DDL is correct on both engines).
const HEARTBEAT_DDL = `CREATE TABLE IF NOT EXISTS job_heartbeat (
  job_name          TEXT PRIMARY KEY,
  last_status       TEXT,
  last_run_at       BIGINT,
  last_success_at   BIGINT,
  last_error        TEXT,
  run_count         INTEGER DEFAULT 0,
  fail_count        INTEGER DEFAULT 0,
  last_alert_sent_at BIGINT
)`;

let _tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!_tableReady) _tableReady = dbExec(HEARTBEAT_DDL).catch(() => { /* already exists / DB not ready */ });
  return _tableReady;
}

// Fallback threshold (hours) for the legacy getStaleJobs() console warning, used only
// for job names NOT present in JOB_REGISTRY (e.g. MONITOR_SCRIPTS-tracked jobs that
// still call recordHeartbeat via the updateMonitorState bridge). Cron-aware lateness
// for JOB_REGISTRY entries is computed by getLateJobs() below instead.
const DEFAULT_STALE_MS = 26 * 60 * 60 * 1000;

const UPSERT_SQL = `
  INSERT INTO job_heartbeat (job_name, last_status, last_run_at, last_success_at, last_error, run_count, fail_count)
  VALUES (?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(job_name) DO UPDATE SET
    last_status     = ?,
    last_run_at     = ?,
    last_success_at = CASE WHEN ? = 'success' THEN ? ELSE job_heartbeat.last_success_at END,
    last_error      = ?,
    run_count       = job_heartbeat.run_count + 1,
    fail_count      = job_heartbeat.fail_count + ?
`;

export async function recordHeartbeat(jobName: string, status: 'success' | 'failed', error?: string): Promise<void> {
  try {
    await ensureTable();
    const now = Date.now();
    const successAt = status === 'success' ? now : null;
    const err = error ?? null;
    const failInc = status === 'failed' ? 1 : 0;
    // params follow placeholder order: VALUES(name,status,now,successAt,err,failInc),
    // then UPDATE(status, now, status, now, err, failInc)
    await dbRun(UPSERT_SQL, [jobName, status, now, successAt, err, failInc, status, now, status, now, err, failInc]);
  } catch {
    // Heartbeat must never break a job.
  }
}

export async function getStaleJobs(): Promise<Array<{ job: string; hoursStale: number }>> {
  await ensureTable();
  const now = Date.now();
  const registryNames = new Set(JOB_REGISTRY.map(j => j.jobName));
  const rows = await dbAll('SELECT job_name, last_success_at FROM job_heartbeat') as
    Array<{ job_name: string; last_success_at: number | null }>;
  const stale: Array<{ job: string; hoursStale: number }> = [];
  for (const r of rows) {
    if (registryNames.has(r.job_name)) continue; // covered by cron-aware getLateJobs() instead
    const last = r.last_success_at ?? 0;
    if (now - last > DEFAULT_STALE_MS) stale.push({ job: r.job_name, hoursStale: Math.floor((now - last) / 3_600_000) });
  }
  return stale;
}

/**
 * Cron-aware lateness check for JOB_REGISTRY entries. A job is "late" when today's most
 * recent expected fire time (per its cron/every schedule) plus its grace period has
 * passed, and no success has been recorded since that fire time. Event-driven entries
 * (no cronPattern/everyMs) are always skipped.
 */
export async function getLateJobs(now: Date = new Date()): Promise<Array<{
  job: string; label: string; expectedAt: Date; hoursLate: number; lastError: string | null;
}>> {
  await ensureTable();
  const rows = await dbAll(
    'SELECT job_name, last_success_at, last_error, last_alert_sent_at FROM job_heartbeat'
  ) as Array<{ job_name: string; last_success_at: number | null; last_error: string | null; last_alert_sent_at: number | null }>;
  const byName = new Map(rows.map(r => [r.job_name, r]));

  const late: Array<{ job: string; label: string; expectedAt: Date; hoursLate: number; lastError: string | null }> = [];
  for (const entry of JOB_REGISTRY) {
    let expectedAt: Date;
    if (entry.cronPattern) {
      const interval = CronExpressionParser.parse(entry.cronPattern, { currentDate: now, tz: 'Etc/UTC' });
      expectedAt = interval.prev().toDate();
    } else if (entry.everyMs) {
      const boundary = Math.floor(now.getTime() / entry.everyMs) * entry.everyMs;
      expectedAt = new Date(boundary);
    } else {
      continue; // event-driven, no schedule to be late against
    }

    const deadline = expectedAt.getTime() + entry.graceMinutes * 60_000;
    if (now.getTime() < deadline) continue; // not late yet

    const row = byName.get(entry.jobName);
    const lastSuccess = row?.last_success_at ?? 0;
    if (lastSuccess >= expectedAt.getTime()) continue; // already succeeded for this occurrence

    late.push({
      job: entry.jobName,
      label: entry.label,
      expectedAt,
      hoursLate: Math.round(((now.getTime() - expectedAt.getTime()) / 3_600_000) * 10) / 10,
      lastError: row?.last_error ?? null,
    });
  }
  return late;
}

/** Records that an alert was already sent for the given occurrence, so the 15-min
 * watchdog poll doesn't re-alert until the NEXT scheduled occurrence passes. */
export async function markAlerted(jobName: string, occurrenceEpochMs: number): Promise<void> {
  try {
    await ensureTable();
    await dbRun(
      `INSERT INTO job_heartbeat (job_name, last_alert_sent_at) VALUES (?, ?)
       ON CONFLICT(job_name) DO UPDATE SET last_alert_sent_at = ?`,
      [jobName, occurrenceEpochMs, occurrenceEpochMs]
    );
  } catch {
    // Never let alert bookkeeping break the watchdog.
  }
}

export async function wasAlreadyAlerted(jobName: string, expectedAt: Date): Promise<boolean> {
  await ensureTable();
  const row = await dbAll(
    'SELECT last_alert_sent_at FROM job_heartbeat WHERE job_name = ?', [jobName]
  ) as Array<{ last_alert_sent_at: number | null }>;
  const sentAt = row[0]?.last_alert_sent_at ?? 0;
  return sentAt >= expectedAt.getTime();
}

/** Periodically log stale jobs (jobs NOT in JOB_REGISTRY — e.g. MONITOR_SCRIPTS-bridged
 * ones already have their own freshness check via getSystemStatus()). */
export function startHeartbeatMonitor(): void {
  const check = async () => {
    const stale = await getStaleJobs();
    for (const s of stale) {
      console.warn(`[HEARTBEAT] STALE: '${s.job}' has not succeeded in ~${s.hoursStale}h`);
    }
  };
  setInterval(() => { void check(); }, 60 * 60 * 1000).unref();
  console.error('[HEARTBEAT] Job staleness monitor started (hourly).');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/jobHeartbeat.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Run full suite + typecheck to confirm no regressions from the schema/column addition**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all existing tests still pass (the DDL adds a column via `CREATE TABLE IF NOT EXISTS`, so existing live tables won't pick up `last_alert_sent_at` automatically — that's fine, `markAlerted`/`wasAlreadyAlerted` use `ON CONFLICT` upserts and `getLateJobs` reads via `dbAll` with `SELECT last_alert_sent_at` which returns `undefined`→treated as `null` on old rows in dev; production job_heartbeat is dropped and recreated by `db.ts` migrations in this project's normal migration flow — no data to preserve, so no explicit ALTER TABLE migration is needed for a dev-only auxiliary table. Verify by running `node -e` against a Postgres box if `USE_POSTGRES=true` is set locally, per Step 6.)

- [ ] **Step 6: Verify existing live `job_heartbeat` table gets the new column**

Run:
```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.POSTGRES_URL || undefined, host: process.env.POSTGRES_HOST, port: process.env.POSTGRES_PORT, user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB });
pool.query(\"ALTER TABLE job_heartbeat ADD COLUMN IF NOT EXISTS last_alert_sent_at BIGINT\").then(() => { console.log('column ensured'); pool.end(); }).catch(e => { console.error(e.message); pool.end(); });
"
```
Expected: `column ensured` (Postgres `IF NOT EXISTS` is a no-op if it already ran once). This is a one-time manual step because `job_heartbeat` is created by `jobHeartbeat.ts`'s own `CREATE TABLE IF NOT EXISTS`, not by `db.ts`'s migration system, so `CREATE TABLE IF NOT EXISTS` alone won't add a column to an already-existing table on the live DB.

- [ ] **Step 7: Commit**

```bash
git add src/server/jobHeartbeat.ts src/server/__tests__/jobHeartbeat.test.ts
git commit -m "feat: cron-aware lateness detection in jobHeartbeat (getLateJobs)"
```

---

## Task 3: Implement `updateMonitorState` (activates 13 dormant call sites for free)

**Files:**
- Modify: `src/server/monitoringService.ts`
- Test: `src/server/__tests__/monitoringService.test.ts` (new)

**Interfaces:**
- Consumes: `recordHeartbeat` from `./jobHeartbeat` (Task 2, unchanged signature).
- Produces: `updateMonitorState(taskName: string, state: 'success' | 'failed', message?: string): void` — same signature as today (callers in `queues.ts` are untouched), but now has a real effect.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/__tests__/monitoringService.test.ts
import { describe, it, expect, vi } from 'vitest';

const recordHeartbeatMock = vi.fn();
vi.mock('../jobHeartbeat', () => ({ recordHeartbeat: recordHeartbeatMock }));

import { updateMonitorState } from '../monitoringService';

describe('updateMonitorState', () => {
  it('delegates success to recordHeartbeat', () => {
    updateMonitorState('quant-eod-sync', 'success');
    expect(recordHeartbeatMock).toHaveBeenCalledWith('quant-eod-sync', 'success', undefined);
  });

  it('delegates failure with message to recordHeartbeat', () => {
    updateMonitorState('fii-dii-fetcher', 'failed', 'timeout');
    expect(recordHeartbeatMock).toHaveBeenCalledWith('fii-dii-fetcher', 'failed', 'timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/monitoringService.test.ts`
Expected: FAIL — current `updateMonitorState` is a no-op, `recordHeartbeatMock` never called.

- [ ] **Step 3: Implement**

```ts
// src/server/monitoringService.ts — replace the stub at the bottom of the file
export function updateMonitorState(taskName: string, state: 'success' | 'failed', message?: string) {
  // Fire-and-forget: recordHeartbeat already swallows its own errors and this function's
  // callers (queues.ts worker event handlers) are synchronous void calls.
  void recordHeartbeat(taskName, state, message);
}
```

And add the import at the top of `src/server/monitoringService.ts`:

```ts
import { dbAll, dbRun } from './dbAsync';
import { recordHeartbeat } from './jobHeartbeat';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/monitoringService.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass. This activates heartbeat tracking for the 13
existing `updateMonitorState(...)` call sites in `queues.ts` (quant-eod-sync,
technical-scan, outcome-resolver-5d/15d, performance-tracker, fii-dii-fetcher,
finbert-scorer, ml-ensemble-score, reward-engine, rl-agent-update, signal-type-stats,
ml-ensemble-train, strategy-optimizer, dl-engine-infer, regime-detector, dl-trainer,
ohlcv-backfill, screener-performance, company-profiles-sync) with zero `queues.ts` changes.

- [ ] **Step 6: Commit**

```bash
git add src/server/monitoringService.ts src/server/__tests__/monitoringService.test.ts
git commit -m "feat: wire updateMonitorState to recordHeartbeat (activates 13 dormant call sites)"
```

---

## Task 4: Extract `getSystemStatus` as a plain function usable outside the tRPC procedure

**Files:**
- Modify: `src/server/routers/monitor.router.ts`
- Test: `src/server/__tests__/monitorSystemStatus.test.ts` (new)

**Interfaces:**
- Produces: `export async function getSystemStatus(): Promise<Array<{ id: string; label: string; category: string; critical: boolean; lastRunAt: string | null; runState: 'never'|'running'|'success'|'failed'|'stale'; stats: Record<string, unknown>; error: string | null }>>` — same return shape the tRPC procedure already produces, now importable directly. Consumed by Task 9 (`jobWatchdog.ts`).

Today the logic lives entirely inline inside `monitorRouter.getSystemStatus`'s `.query(async () => {...})` callback (`monitor.router.ts:390-425`). Pull that callback body into a standalone exported function and have the tRPC procedure call it — behavior is unchanged, it's just now reachable from `jobWatchdog.ts` without an HTTP round trip.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/__tests__/monitorSystemStatus.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async (sql: string) => {
    if (sql.includes('app_settings')) return undefined;
    return { t: null };
  }),
  dbAll: vi.fn(async (sql: string) => {
    if (sql.includes('app_settings')) return [];
    return [];
  }),
  dbRun: vi.fn(async () => {}),
}));

import { getSystemStatus } from '../routers/monitor.router';
import { MONITOR_SCRIPTS } from '../routers/monitor.router';

describe('getSystemStatus (extracted)', () => {
  it('returns one entry per MONITOR_SCRIPTS item with a runState', async () => {
    const status = await getSystemStatus();
    expect(status.length).toBe(MONITOR_SCRIPTS.length);
    for (const s of status) {
      expect(['never', 'running', 'success', 'failed', 'stale']).toContain(s.runState);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/monitorSystemStatus.test.ts`
Expected: FAIL with "getSystemStatus is not exported" (it's currently only a closure inside the router).

- [ ] **Step 3: Extract the function**

In `src/server/routers/monitor.router.ts`, replace:

```ts
export const monitorRouter = router({
  getSystemStatus: publicProcedure.query(async () => {
    const runStates: Record<string, string> = {};
    try {
      const rows = await dbAll<any>("SELECT key, value FROM app_settings WHERE key LIKE 'monitor_%'");
      for (const r of rows) runStates[r.key] = r.value;
    } catch (err: unknown) {
      console.warn('[MONITOR] getSystemStatus failed:', (err as Error).message);
    }

    return Promise.all(MONITOR_SCRIPTS.map(async s => {
      const dbLastRunAt = await getLastRunAt(s.id as ScriptId);
      // Fall back to stored timestamp for scripts that ran but produced no DB rows
      const storedRanAt = runStates[`monitor_${s.id}_ran_at`] ?? null;
      const lastRunAt = dbLastRunAt ?? storedRanAt;
      const stateKey = `monitor_${s.id}`;
      const rawState = runStates[stateKey];
      let runState: 'never' | 'running' | 'success' | 'failed' | 'stale' = 'never';

      if (rawState === 'running') {
        runState = 'running';
      } else if (lastRunAt) {
        const ageHours = (Date.now() - new Date(lastRunAt).getTime()) / 3600000;
        runState = ageHours > s.staleLimitHours ? 'stale' : (rawState === 'failed' ? 'failed' : 'success');
      } else {
        runState = rawState === 'failed' ? 'failed' : 'never';
      }

      return {
        ...s,
        lastRunAt,
        runState,
        stats: await getScriptStats(s.id as ScriptId),
        error: runStates[`monitor_${s.id}_error`] ?? null,
      };
    }));
  }),
```

with:

```ts
export async function getSystemStatus() {
  const runStates: Record<string, string> = {};
  try {
    const rows = await dbAll<any>("SELECT key, value FROM app_settings WHERE key LIKE 'monitor_%'");
    for (const r of rows) runStates[r.key] = r.value;
  } catch (err: unknown) {
    console.warn('[MONITOR] getSystemStatus failed:', (err as Error).message);
  }

  return Promise.all(MONITOR_SCRIPTS.map(async s => {
    const dbLastRunAt = await getLastRunAt(s.id as ScriptId);
    // Fall back to stored timestamp for scripts that ran but produced no DB rows
    const storedRanAt = runStates[`monitor_${s.id}_ran_at`] ?? null;
    const lastRunAt = dbLastRunAt ?? storedRanAt;
    const stateKey = `monitor_${s.id}`;
    const rawState = runStates[stateKey];
    let runState: 'never' | 'running' | 'success' | 'failed' | 'stale' = 'never';

    if (rawState === 'running') {
      runState = 'running';
    } else if (lastRunAt) {
      const ageHours = (Date.now() - new Date(lastRunAt).getTime()) / 3600000;
      runState = ageHours > s.staleLimitHours ? 'stale' : (rawState === 'failed' ? 'failed' : 'success');
    } else {
      runState = rawState === 'failed' ? 'failed' : 'never';
    }

    return {
      ...s,
      lastRunAt,
      runState,
      stats: await getScriptStats(s.id as ScriptId),
      error: runStates[`monitor_${s.id}_error`] ?? null,
    };
  }));
}

export const monitorRouter = router({
  getSystemStatus: publicProcedure.query(() => getSystemStatus()),
```

(Everything else in the router — `getIndexAdvanceDecline`, `triggerScript`, `getBullMQJobsStatus`, etc. — is unchanged; only the `getSystemStatus` procedure body moves out.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/monitorSystemStatus.test.ts`
Expected: PASS (1/1)

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass (including any existing router-level tests that call `caller.getSystemStatus()` — behavior is identical, just relocated).

- [ ] **Step 6: Commit**

```bash
git add src/server/routers/monitor.router.ts src/server/__tests__/monitorSystemStatus.test.ts
git commit -m "refactor: extract getSystemStatus as a standalone function for reuse by jobWatchdog"
```

---

## Task 5: Wire `recordHeartbeat` into Cluster A (data-sync queues)

**Files:**
- Modify: `src/server/queues.ts`

Covers: `mc-screener-sync`, `etnow-screener-sync`, `nse-sync`, `fundamentals-sync`, `live-screener-collect`. All five are the "plain `console.log`/`console.error`, no monitoring call at all" pattern confirmed during investigation — add `recordHeartbeat` alongside the existing console calls, do not remove the console calls.

- [ ] **Step 1: Wire mc-screener-sync**

In `src/server/queues.ts`, find:

```ts
    mcScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] mc-screener-sync completed`);
    });
    mcScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] mc-screener-sync failed:`, err.message);
    });
```

Replace with:

```ts
    mcScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] mc-screener-sync completed`);
      recordHeartbeat('mc-screener-sync', 'success');
    });
    mcScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] mc-screener-sync failed:`, err.message);
      recordHeartbeat('mc-screener-sync', 'failed', err.message);
    });
```

- [ ] **Step 2: Wire etnow-screener-sync**

Find:

```ts
    etnowScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] etnow-screener-sync completed`);
    });
    etnowScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] etnow-screener-sync failed:`, err.message);
    });
```

Replace with:

```ts
    etnowScreenerSyncWorker.on('completed', (_job) => {
      console.log(`[QUEUE] etnow-screener-sync completed`);
      recordHeartbeat('etnow-screener-sync', 'success');
    });
    etnowScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] etnow-screener-sync failed:`, err.message);
      recordHeartbeat('etnow-screener-sync', 'failed', err.message);
    });
```

- [ ] **Step 3: Wire nse-sync**

Find:

```ts
    nseScreenerSyncWorker.on('completed', (job) => {
      const result = job.returnvalue as any;
      console.log(`[QUEUE] nse-sync completed (${result?.stockCount || 0} stocks)`);
    });
    nseScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] nse-sync failed:`, err.message);
    });
```

Replace with:

```ts
    nseScreenerSyncWorker.on('completed', (job) => {
      const result = job.returnvalue as any;
      console.log(`[QUEUE] nse-sync completed (${result?.stockCount || 0} stocks)`);
      recordHeartbeat('nse-sync', 'success');
    });
    nseScreenerSyncWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] nse-sync failed:`, err.message);
      recordHeartbeat('nse-sync', 'failed', err.message);
    });
```

- [ ] **Step 4: Wire fundamentals-sync**

Find:

```ts
    fundamentalsSyncWorker.on('completed', (_job) => {
      console.log('[QUEUE] fundamentals-sync completed');
    });
    fundamentalsSyncWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] fundamentals-sync failed:', err.message);
    });
```

Replace with:

```ts
    fundamentalsSyncWorker.on('completed', (_job) => {
      console.log('[QUEUE] fundamentals-sync completed');
      recordHeartbeat('fundamentals-sync', 'success');
    });
    fundamentalsSyncWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] fundamentals-sync failed:', err.message);
      recordHeartbeat('fundamentals-sync', 'failed', err.message);
    });
```

- [ ] **Step 5: Wire live-screener-collect**

Find:

```ts
    liveScreenerCollectWorker.on('completed', () => {
      console.log('[QUEUE] live-screener-collect completed');
    });
    liveScreenerCollectWorker.on('failed', (_, err) => {
      console.error('[QUEUE] live-screener-collect failed:', err.message);
    });
```

Replace with:

```ts
    liveScreenerCollectWorker.on('completed', () => {
      console.log('[QUEUE] live-screener-collect completed');
      recordHeartbeat('live-screener-collect', 'success');
    });
    liveScreenerCollectWorker.on('failed', (_, err) => {
      console.error('[QUEUE] live-screener-collect failed:', err.message);
      recordHeartbeat('live-screener-collect', 'failed', err.message);
    });
```

- [ ] **Step 6: Typecheck + run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass (`recordHeartbeat` is already imported in `queues.ts` line 32, no new import needed).

- [ ] **Step 7: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: wire recordHeartbeat into data-sync queue workers (mc/etnow/nse/fundamentals/live-screener)"
```

---

## Task 6: Wire `recordHeartbeat` into Cluster B (scoring/signals queues)

**Files:**
- Modify: `src/server/queues.ts`

Covers: `quant-scoring`, `signal-outcomes`, `trendlyne-intraday`, `unified-ranker`, `ai-signals`.

- [ ] **Step 1: Wire quant-scoring**

Find:

```ts
    quantScoringWorker.on('completed', (_job) => {
      console.log('[QUEUE] quant-scoring completed');
    });
    quantScoringWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] quant-scoring failed:', err.message);
    });
```

Replace with:

```ts
    quantScoringWorker.on('completed', (_job) => {
      console.log('[QUEUE] quant-scoring completed');
      recordHeartbeat('quant-scoring', 'success');
    });
    quantScoringWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] quant-scoring failed:', err.message);
      recordHeartbeat('quant-scoring', 'failed', err.message);
    });
```

- [ ] **Step 2: Wire signal-outcomes**

Find:

```ts
    signalOutcomesWorker.on('completed', (_job) => {
      console.log('[QUEUE] signal-outcomes completed');
    });
    signalOutcomesWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] signal-outcomes failed:', err.message);
    });
```

Replace with:

```ts
    signalOutcomesWorker.on('completed', (_job) => {
      console.log('[QUEUE] signal-outcomes completed');
      recordHeartbeat('signal-outcomes', 'success');
    });
    signalOutcomesWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] signal-outcomes failed:', err.message);
      recordHeartbeat('signal-outcomes', 'failed', err.message);
    });
```

- [ ] **Step 3: Wire trendlyne-intraday**

Find:

```ts
    trendlyneIntradayWorker.on('completed', (_job) => {
      console.log('[QUEUE] trendlyne-intraday completed');
    });
    trendlyneIntradayWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-intraday failed:', err.message);
    });
```

Replace with:

```ts
    trendlyneIntradayWorker.on('completed', (_job) => {
      console.log('[QUEUE] trendlyne-intraday completed');
      recordHeartbeat('trendlyne-intraday', 'success');
    });
    trendlyneIntradayWorker.on('failed', (_job, err) => {
      console.error('[QUEUE] trendlyne-intraday failed:', err.message);
      recordHeartbeat('trendlyne-intraday', 'failed', err.message);
    });
```

- [ ] **Step 4: Wire unified-ranker**

Find:

```ts
    unifiedRankerWorkerInstance.on('completed', () =>
      console.log('[QUEUE] unified-ranker done'));
    unifiedRankerWorkerInstance.on('failed', (_, err) =>
      console.error('[QUEUE] unified-ranker failed:', err.message));
```

Replace with:

```ts
    unifiedRankerWorkerInstance.on('completed', () => {
      console.log('[QUEUE] unified-ranker done');
      recordHeartbeat('unified-ranker', 'success');
    });
    unifiedRankerWorkerInstance.on('failed', (_, err) => {
      console.error('[QUEUE] unified-ranker failed:', err.message);
      recordHeartbeat('unified-ranker', 'failed', err.message);
    });
```

- [ ] **Step 5: Wire ai-signals**

Find:

```ts
    signalWorker.on('completed', (job) => {
      console.log(`[QUEUE] ai-signals job ${job?.data?.symbol} completed successfully`);
    });

    signalWorker.on('failed', (job, err) => {
      console.warn(`[QUEUE] ai-signals job ${job?.data?.symbol} failed:`, err.message);
    });
```

Replace with:

```ts
    signalWorker.on('completed', (job) => {
      console.log(`[QUEUE] ai-signals job ${job?.data?.symbol} completed successfully`);
      recordHeartbeat('ai-signals', 'success');
    });

    signalWorker.on('failed', (job, err) => {
      console.warn(`[QUEUE] ai-signals job ${job?.data?.symbol} failed:`, err.message);
      recordHeartbeat('ai-signals', 'failed', err.message);
    });
```

- [ ] **Step 6: Typecheck + run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: wire recordHeartbeat into scoring/signals queue workers (quant/outcomes/trendlyne/ranker/ai-signals)"
```

---

## Task 7: Wire `recordHeartbeat` into Cluster C (research/macro/DL/preopen queues)

**Files:**
- Modify: `src/server/queues.ts`

Covers: `research-premarket`, `research-postclose`, `dl-macro-fetch`, `dl-feature-refresh`,
`dl-retrain-emergency`, and the two anonymous workers `preopen-snapshot` +
`market-regime-refresh` (which need restructuring since they have no `.on()` handlers and
swallow their own errors via `.catch()`).

- [ ] **Step 1: Wire research-premarket**

Find:

```ts
    researchPremarketWorker.on('completed', () => console.log('[QUEUE] research-premarket done'));
    researchPremarketWorker.on('failed', (_, err) => console.error('[QUEUE] research-premarket failed:', err.message));
```

Replace with:

```ts
    researchPremarketWorker.on('completed', () => {
      console.log('[QUEUE] research-premarket done');
      recordHeartbeat('research-premarket', 'success');
    });
    researchPremarketWorker.on('failed', (_, err) => {
      console.error('[QUEUE] research-premarket failed:', err.message);
      recordHeartbeat('research-premarket', 'failed', err.message);
    });
```

- [ ] **Step 2: Wire research-postclose**

Find:

```ts
    researchPostcloseWorker.on('completed', () => console.log('[QUEUE] research-postclose done'));
    researchPostcloseWorker.on('failed', (_, err) => console.error('[QUEUE] research-postclose failed:', err.message));
```

Replace with:

```ts
    researchPostcloseWorker.on('completed', () => {
      console.log('[QUEUE] research-postclose done');
      recordHeartbeat('research-postclose', 'success');
    });
    researchPostcloseWorker.on('failed', (_, err) => {
      console.error('[QUEUE] research-postclose failed:', err.message);
      recordHeartbeat('research-postclose', 'failed', err.message);
    });
```

- [ ] **Step 3: Wire dl-macro-fetch**

Find (the `completed` handler near line 1740 and the `failed` handler near line 1764 — they're
split apart in the file by the interleaved preopen-snapshot block, but both attach to the same
`dlMacroFetchWorker`):

```ts
    dlMacroFetchWorker.on('completed', () => console.log('[QUEUE] dl-macro-fetch done'));
```

Replace with:

```ts
    dlMacroFetchWorker.on('completed', () => {
      console.log('[QUEUE] dl-macro-fetch done');
      recordHeartbeat('dl-macro-fetch', 'success');
    });
```

And find:

```ts
    dlMacroFetchWorker.on('failed', (_, err) => console.error('[QUEUE] dl-macro-fetch failed:', err.message));
```

Replace with:

```ts
    dlMacroFetchWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-macro-fetch failed:', err.message);
      recordHeartbeat('dl-macro-fetch', 'failed', err.message);
    });
```

- [ ] **Step 4: Wire dl-feature-refresh**

Find:

```ts
    dlFeatureRefreshWorker.on('completed', () => console.log('[QUEUE] dl-feature-refresh done'));
    dlFeatureRefreshWorker.on('failed', (_, err) => console.error('[QUEUE] dl-feature-refresh failed:', err.message));
```

Replace with:

```ts
    dlFeatureRefreshWorker.on('completed', () => {
      console.log('[QUEUE] dl-feature-refresh done');
      recordHeartbeat('dl-feature-refresh', 'success');
    });
    dlFeatureRefreshWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-feature-refresh failed:', err.message);
      recordHeartbeat('dl-feature-refresh', 'failed', err.message);
    });
```

- [ ] **Step 5: Wire dl-retrain-emergency**

Find:

```ts
    dlRetrainEmergencyWorker.on('completed', () => console.log('[QUEUE] dl-retrain-emergency done'));
    dlRetrainEmergencyWorker.on('failed', (_, err) => console.error('[QUEUE] dl-retrain-emergency failed:', err.message));
```

Replace with:

```ts
    dlRetrainEmergencyWorker.on('completed', () => {
      console.log('[QUEUE] dl-retrain-emergency done');
      recordHeartbeat('dl-retrain-emergency', 'success');
    });
    dlRetrainEmergencyWorker.on('failed', (_, err) => {
      console.error('[QUEUE] dl-retrain-emergency failed:', err.message);
      recordHeartbeat('dl-retrain-emergency', 'failed', err.message);
    });
```

- [ ] **Step 6: Wire preopen-snapshot (anonymous worker, error-swallowing processor)**

Find:

```ts
    new Worker(QUEUE_PREOPEN,
      async () => {
        await runPython('preopen_fetcher.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] preopen_fetcher failed:', (e as Error).message));

        console.log('[QUEUE] Running early_hours_predictor...');
        await runPython('early_hours_predictor.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] early_hours_predictor failed:', (e as Error).message));
      },
      { connection, concurrency: 1 });
```

Replace with (heartbeat calls go inside the `.catch()`/success paths directly, since the
processor never rejects and a `.on('failed', ...)` handler would never fire):

```ts
    new Worker(QUEUE_PREOPEN,
      async () => {
        await runPython('preopen_fetcher.py', [], 60_000)
          .then(() => recordHeartbeat('preopen-snapshot', 'success'))
          .catch(e => {
            console.warn('[QUEUE] preopen_fetcher failed:', (e as Error).message);
            recordHeartbeat('preopen-snapshot', 'failed', (e as Error).message);
          });

        console.log('[QUEUE] Running early_hours_predictor...');
        await runPython('early_hours_predictor.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] early_hours_predictor failed:', (e as Error).message));
      },
      { connection, concurrency: 1 });
```

(Only `preopen_fetcher.py` drives the `preopen-snapshot` heartbeat — it's the primary step this
job exists for; `early_hours_predictor.py` failures still log but don't flip the heartbeat, matching
the existing best-effort nature of that second call.)

- [ ] **Step 7: Wire market-regime-refresh (same anonymous-worker pattern)**

Find:

```ts
    new Worker(QUEUE_REGIME,
      async () => {
        await runPython('market_regime_fetcher.py', [], 60_000)
          .catch(e => console.warn('[QUEUE] market_regime_fetcher failed:', (e as Error).message));
      },
      { connection, concurrency: 1 });
```

Replace with:

```ts
    new Worker(QUEUE_REGIME,
      async () => {
        await runPython('market_regime_fetcher.py', [], 60_000)
          .then(() => recordHeartbeat('market-regime-refresh', 'success'))
          .catch(e => {
            console.warn('[QUEUE] market_regime_fetcher failed:', (e as Error).message);
            recordHeartbeat('market-regime-refresh', 'failed', (e as Error).message);
          });
      },
      { connection, concurrency: 1 });
```

- [ ] **Step 8: Typecheck + run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: wire recordHeartbeat into research/macro/DL/preopen queue workers"
```

---

## Task 8: Wire `recordHeartbeat` into Cluster D (confluence + agent queues)

**Files:**
- Modify: `src/server/queues.ts`

Covers: `confluence-compute`, `confluence-outcomes` (both currently missing a `completed`
handler entirely — add it, don't just extend `failed`), `agent-data-scientist`,
`agent-strategist`, `agent-auditor`, `agent-optimizer`.

- [ ] **Step 1: Wire confluence-compute (add missing completed handler)**

Find:

```ts
    confluenceComputeWorker.on('failed', (_job, err) =>
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} job failed:`, err.message)
    );
    confluenceComputeWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} error:`, err.message);
    });
```

Replace with:

```ts
    confluenceComputeWorker.on('completed', () => {
      recordHeartbeat('confluence-compute', 'success');
    });
    confluenceComputeWorker.on('failed', (_job, err) => {
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} job failed:`, err.message);
      recordHeartbeat('confluence-compute', 'failed', err.message);
    });
    confluenceComputeWorker.on('error', (err) => {
      if ((err as any).code === -2 || err.message?.includes('Missing lock')) return;
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_COMPUTE} error:`, err.message);
    });
```

- [ ] **Step 2: Wire confluence-outcomes (add missing completed handler)**

Find:

```ts
    confluenceOutcomesWorker.on('failed', (job, err) =>
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_OUTCOMES} job failed:`, err.message)
    );
```

Replace with:

```ts
    confluenceOutcomesWorker.on('completed', () => {
      recordHeartbeat('confluence-outcomes', 'success');
    });
    confluenceOutcomesWorker.on('failed', (job, err) => {
      console.error(`[QUEUE] ${QUEUE_CONFLUENCE_OUTCOMES} job failed:`, err.message);
      recordHeartbeat('confluence-outcomes', 'failed', err.message);
    });
```

- [ ] **Step 3: Wire agent-data-scientist**

Find:

```ts
    agentDataScientistWorker.on('completed', (_, r: any) => console.log('[QUEUE] agent-ds done, grade=', r?.grade));
    agentDataScientistWorker.on('failed', (_, e) => console.error('[QUEUE] agent-ds failed:', e.message));
```

Replace with:

```ts
    agentDataScientistWorker.on('completed', (_, r: any) => {
      console.log('[QUEUE] agent-ds done, grade=', r?.grade);
      recordHeartbeat('agent-data-scientist', 'success');
    });
    agentDataScientistWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-ds failed:', e.message);
      recordHeartbeat('agent-data-scientist', 'failed', e.message);
    });
```

- [ ] **Step 4: Wire agent-strategist**

Find:

```ts
    agentStrategistWorker.on('completed', () => console.log('[QUEUE] agent-strategist done'));
    agentStrategistWorker.on('failed', (_, e) => console.error('[QUEUE] agent-strategist failed:', e.message));
```

Replace with:

```ts
    agentStrategistWorker.on('completed', () => {
      console.log('[QUEUE] agent-strategist done');
      recordHeartbeat('agent-strategist', 'success');
    });
    agentStrategistWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-strategist failed:', e.message);
      recordHeartbeat('agent-strategist', 'failed', e.message);
    });
```

- [ ] **Step 5: Wire agent-auditor**

Find:

```ts
    agentAuditorWorker.on('completed', () => console.log('[QUEUE] agent-auditor done'));
    agentAuditorWorker.on('failed', (_, e) => console.error('[QUEUE] agent-auditor failed:', e.message));
```

Replace with:

```ts
    agentAuditorWorker.on('completed', () => {
      console.log('[QUEUE] agent-auditor done');
      recordHeartbeat('agent-auditor', 'success');
    });
    agentAuditorWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-auditor failed:', e.message);
      recordHeartbeat('agent-auditor', 'failed', e.message);
    });
```

- [ ] **Step 6: Wire agent-optimizer**

Find:

```ts
    agentOptimizerWorker.on('completed', () => console.log('[QUEUE] agent-optimizer done'));
    agentOptimizerWorker.on('failed', (_, e) => console.error('[QUEUE] agent-optimizer failed:', e.message));
```

Replace with:

```ts
    agentOptimizerWorker.on('completed', () => {
      console.log('[QUEUE] agent-optimizer done');
      recordHeartbeat('agent-optimizer', 'success');
    });
    agentOptimizerWorker.on('failed', (_, e) => {
      console.error('[QUEUE] agent-optimizer failed:', e.message);
      recordHeartbeat('agent-optimizer', 'failed', e.message);
    });
```

- [ ] **Step 7: Typecheck + run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: wire recordHeartbeat into confluence and agent queue workers"
```

---

## Task 9: `jobWatchdog.ts` — combined lateness check + daily digest builder

**Files:**
- Create: `src/server/jobWatchdog.ts`
- Test: `src/server/__tests__/jobWatchdog.test.ts`

**Interfaces:**
- Consumes: `getLateJobs`, `wasAlreadyAlerted`, `markAlerted` from `./jobHeartbeat` (Task 2); `getSystemStatus` from `./routers/monitor.router` (Task 4); `telegramService` from `./telegramService` (existing, unchanged).
- Produces: `export async function checkAndAlertLateJobs(now?: Date): Promise<void>` and `export async function buildDailyDigest(now?: Date): Promise<string>` and `export function startJobWatchdog(): void`. Consumed by Task 10 (`queues.ts` wiring).

- [ ] **Step 1: Write the failing test**

```ts
// src/server/__tests__/jobWatchdog.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn(async () => true);
vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: sendMock },
}));

const getLateJobsMock = vi.fn();
const wasAlreadyAlertedMock = vi.fn();
const markAlertedMock = vi.fn();
vi.mock('../jobHeartbeat', () => ({
  getLateJobs: getLateJobsMock,
  wasAlreadyAlerted: wasAlreadyAlertedMock,
  markAlerted: markAlertedMock,
}));

vi.mock('../jobRegistry', () => ({
  JOB_REGISTRY: [
    { jobName: 'critical-job', label: 'Critical Job', cronPattern: '0 10 * * 1-5', graceMinutes: 45, critical: true },
    { jobName: 'noncritical-job', label: 'Noncritical Job', cronPattern: '0 11 * * 1-5', graceMinutes: 45, critical: false },
  ],
}));

const getSystemStatusMock = vi.fn(async () => []);
vi.mock('../routers/monitor.router', () => ({
  getSystemStatus: getSystemStatusMock,
  MONITOR_SCRIPTS: [],
}));

import { checkAndAlertLateJobs, buildDailyDigest } from '../jobWatchdog';

describe('checkAndAlertLateJobs', () => {
  beforeEach(() => {
    sendMock.mockClear();
    markAlertedMock.mockClear();
    wasAlreadyAlertedMock.mockReset().mockResolvedValue(false);
  });

  it('sends one Telegram alert for a late critical job not yet alerted', async () => {
    getLateJobsMock.mockResolvedValue([
      { job: 'critical-job', label: 'Critical Job', expectedAt: new Date('2026-07-02T10:00:00Z'), hoursLate: 2, lastError: null },
    ]);
    await checkAndAlertLateJobs(new Date('2026-07-02T12:00:00Z'));
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toContain('Critical Job');
    expect(markAlertedMock).toHaveBeenCalledWith('critical-job', new Date('2026-07-02T10:00:00Z').getTime());
  });

  it('does not re-alert if wasAlreadyAlerted returns true for this occurrence', async () => {
    getLateJobsMock.mockResolvedValue([
      { job: 'critical-job', label: 'Critical Job', expectedAt: new Date('2026-07-02T10:00:00Z'), hoursLate: 2, lastError: null },
    ]);
    wasAlreadyAlertedMock.mockResolvedValue(true);
    await checkAndAlertLateJobs(new Date('2026-07-02T12:00:00Z'));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does not alert for a late but non-critical job', async () => {
    getLateJobsMock.mockResolvedValue([
      { job: 'noncritical-job', label: 'Noncritical Job', expectedAt: new Date('2026-07-02T11:00:00Z'), hoursLate: 1, lastError: null },
    ]);
    await checkAndAlertLateJobs(new Date('2026-07-02T13:00:00Z'));
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('buildDailyDigest', () => {
  it('includes every registry job and every MONITOR_SCRIPTS entry', async () => {
    getLateJobsMock.mockResolvedValue([]);
    getSystemStatusMock.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'success', lastRunAt: '2026-07-02T09:00:00Z', critical: true },
    ]);
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Critical Job');
    expect(digest).toContain('Noncritical Job');
    expect(digest).toContain('Technical Signal Scan');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/jobWatchdog.test.ts`
Expected: FAIL with "Cannot find module '../jobWatchdog'"

- [ ] **Step 3: Implement `jobWatchdog.ts`**

```ts
// src/server/jobWatchdog.ts
/**
 * Combines the two existing freshness signals — cron-aware job_heartbeat lateness
 * (jobHeartbeat.ts, for pure-BullMQ queues) and MONITOR_SCRIPTS/getSystemStatus
 * (monitor.router.ts, for the 20 Python-engine entries with real DB-freshness checks) —
 * into one Telegram watchdog + daily digest. Deliberately does not introduce a third
 * job registry: see docs/superpowers/specs/2026-07-02-job-monitoring-telegram-alerts-design.md.
 */
import { getLateJobs, wasAlreadyAlerted, markAlerted } from './jobHeartbeat';
import { JOB_REGISTRY } from './jobRegistry';
import { getSystemStatus } from './routers/monitor.router';
import { telegramService } from './telegramService';

export async function checkAndAlertLateJobs(now: Date = new Date()): Promise<void> {
  const late = await getLateJobs(now);
  const registryByName = new Map(JOB_REGISTRY.map(j => [j.jobName, j]));

  for (const item of late) {
    const entry = registryByName.get(item.job);
    if (!entry?.critical) continue;
    if (await wasAlreadyAlerted(item.job, item.expectedAt)) continue;

    const errorLine = item.lastError ? `\nLast error: \`${item.lastError.slice(0, 300)}\`` : '';
    const text = `⚠️ *Job running late*: \`${item.label}\`\nExpected by ~${item.expectedAt.toISOString()} (${item.hoursLate}h late)${errorLine}`;
    await telegramService.sendMarkdownMessage(text);
    await markAlerted(item.job, item.expectedAt.getTime());
  }
}

export async function buildDailyDigest(now: Date = new Date()): Promise<string> {
  const late = await getLateJobs(now);
  const lateNames = new Set(late.map(l => l.job));

  const registryLines = JOB_REGISTRY
    .filter(j => j.cronPattern || j.everyMs) // skip event-driven in the scheduled section
    .map(j => `${lateNames.has(j.jobName) ? '⚠️' : '✅'} ${j.label}`)
    .join('\n');

  const eventDrivenLines = JOB_REGISTRY
    .filter(j => !j.cronPattern && !j.everyMs)
    .map(j => `⏳ ${j.label} (event-driven)`)
    .join('\n');

  const scriptStatuses = await getSystemStatus();
  const scriptIcon = (state: string) => state === 'success' ? '✅' : state === 'stale' ? '⚠️' : state === 'failed' ? '❌' : '⏳';
  const scriptLines = scriptStatuses.map((s: any) => `${scriptIcon(s.runState)} ${s.label} (${s.runState})`).join('\n');

  return [
    `📋 *Daily Job Health Digest* — ${now.toISOString().slice(0, 10)}`,
    '',
    '*Scheduled queues:*',
    registryLines,
    '',
    '*Event-driven:*',
    eventDrivenLines,
    '',
    '*ML/data engines:*',
    scriptLines,
  ].join('\n');
}

export function startJobWatchdog(): void {
  const check = async () => {
    try {
      await checkAndAlertLateJobs();
    } catch (err) {
      console.error('[WATCHDOG] checkAndAlertLateJobs failed:', (err as Error).message);
    }
  };
  setInterval(() => { void check(); }, 15 * 60 * 1000).unref();
  console.log('[WATCHDOG] Job lateness watchdog started (every 15 min).');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/jobWatchdog.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Typecheck + run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/jobWatchdog.ts src/server/__tests__/jobWatchdog.test.ts
git commit -m "feat: add jobWatchdog with cron-aware late-job Telegram alerts + daily digest builder"
```

---

## Task 10: Wire the watchdog + daily digest queue into `queues.ts` startup

**Files:**
- Modify: `src/server/queues.ts`

**Interfaces:**
- Consumes: `startJobWatchdog`, `buildDailyDigest` from `./jobWatchdog` (Task 9).

- [ ] **Step 1: Add the import**

In `src/server/queues.ts`, find:

```ts
import { recordHeartbeat, startHeartbeatMonitor } from './jobHeartbeat';
```

Replace with:

```ts
import { recordHeartbeat, startHeartbeatMonitor } from './jobHeartbeat';
import { startJobWatchdog, buildDailyDigest } from './jobWatchdog';
import { telegramService } from './telegramService';
```

- [ ] **Step 2: Add the daily digest queue + worker, and start the watchdog**

Find (end of the unified-ranker block, right before the heartbeat monitor starts):

```ts
    unifiedRankerWorkerInstance.on('completed', () => {
      console.log('[QUEUE] unified-ranker done');
      recordHeartbeat('unified-ranker', 'success');
    });
    unifiedRankerWorkerInstance.on('failed', (_, err) => {
      console.error('[QUEUE] unified-ranker failed:', err.message);
      recordHeartbeat('unified-ranker', 'failed', err.message);
    });

    console.warn = _origWarn;
    startHeartbeatMonitor();
```

Replace with:

```ts
    unifiedRankerWorkerInstance.on('completed', () => {
      console.log('[QUEUE] unified-ranker done');
      recordHeartbeat('unified-ranker', 'success');
    });
    unifiedRankerWorkerInstance.on('failed', (_, err) => {
      console.error('[QUEUE] unified-ranker failed:', err.message);
      recordHeartbeat('unified-ranker', 'failed', err.message);
    });

    // ── Daily job-health digest — 9:00 PM IST (15:30 UTC), every day ──────────────
    const QUEUE_JOB_DIGEST = 'job-digest';
    const jobDigestQueue = new Queue(QUEUE_JOB_DIGEST, { connection });
    const jobDigestWorker = new Worker(
      QUEUE_JOB_DIGEST,
      async () => {
        const digest = await buildDailyDigest();
        await telegramService.sendMarkdownMessage(digest);
      },
      { connection, concurrency: 1 },
    );
    jobDigestWorker.on('completed', () => console.log('[QUEUE] job-digest sent'));
    jobDigestWorker.on('failed', (_, err) => console.error('[QUEUE] job-digest failed:', err.message));

    const digestRepeatables = await jobDigestQueue.getRepeatableJobs();
    for (const r of digestRepeatables) await jobDigestQueue.removeRepeatableByKey(r.key);
    await addJobWithCatchup(jobDigestQueue, 'job-digest-daily', {}, {
      repeat: { pattern: '30 15 * * *' }, // 9:00 PM IST daily, all 7 days
      jobId: 'job-digest-daily-repeatable',
      removeOnComplete: 3,
      removeOnFail: 3,
    });

    console.warn = _origWarn;
    startHeartbeatMonitor();
    startJobWatchdog();
```

- [ ] **Step 3: Typecheck + run full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/queues.ts
git commit -m "feat: schedule daily 9PM IST job-health digest and start the lateness watchdog"
```

---

## Task 11: Telegram credentials + end-to-end smoke test (manual, no code changes)

**Files:** none (verification only — `.env` is gitignored, not committed).

- [ ] **Step 1: Set credentials**

Ask the user for their `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (from @BotFather + the
target chat) if not already provided, and set them in `.env`:

```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat id>
```

- [ ] **Step 2: Smoke-test basic delivery**

Run:
```bash
node -e "
require('dotenv').config();
const { spawnSync } = require('child_process');
" 2>/dev/null
npx tsx -e "
import { telegramService } from './src/server/telegramService';
telegramService.sendMarkdownMessage('✅ Job monitoring smoke test — if you see this, Telegram delivery works.').then(ok => {
  console.log('sent:', ok);
  process.exit(ok ? 0 : 1);
});
"
```
Expected: a message arrives in the configured Telegram chat within a few seconds, and the
command prints `sent: true`.

- [ ] **Step 3: Smoke-test the lateness alert path**

Run:
```bash
npx tsx -e "
import { recordHeartbeat } from './src/server/jobHeartbeat';
import { checkAndAlertLateJobs } from './src/server/jobWatchdog';
(async () => {
  // Force 'mc-screener-sync' (critical, weekday 11 PM IST / 17:30 UTC, 60min grace) to look
  // like it last succeeded 3 days ago, then run the watchdog check as if it's well past due.
  await recordHeartbeat('mc-screener-sync', 'success');
  const { dbRun } = await import('./src/server/dbAsync');
  await dbRun('UPDATE job_heartbeat SET last_success_at = ? WHERE job_name = ?', [Date.now() - 3 * 86_400_000, 'mc-screener-sync']);
  await checkAndAlertLateJobs(new Date('2026-07-03T19:00:00Z')); // well past 17:30 UTC + 60min grace on a weekday
  console.log('watchdog check complete — check Telegram for one alert');
})();
"
```
Expected: exactly one Telegram message about `MoneyControl Screener Sync` running late arrives.
Run the same command a second time immediately after — expect **no** second message (the
`wasAlreadyAlerted` dedup should suppress it for the same occurrence).

- [ ] **Step 4: Restore real state**

Run:
```bash
npx tsx -e "
import { recordHeartbeat } from './src/server/jobHeartbeat';
recordHeartbeat('mc-screener-sync', 'success').then(() => console.log('restored'));
"
```

- [ ] **Step 5: Report results to the user**

Summarize: Telegram delivery confirmed working, lateness alert fires once per occurrence and
suppresses duplicates, daily digest is scheduled for 9 PM IST. No commit for this task (manual
verification only).

---

## Self-review notes

- **Spec coverage:** design's 4 architecture pieces (jobRegistry, jobHeartbeat extension,
  updateMonitorState wiring + remaining worker wiring, jobWatchdog with late-check + digest)
  map to Tasks 1, 2, 3+5-8, 9-10 respectively. The design-revision section (reusing
  `MONITOR_SCRIPTS`/`getSystemStatus`) maps to Task 4. The design's testing section (unit
  tests for lateness math + digest formatting, manual Telegram smoke test) maps to Tasks 2, 9,
  11. Non-goals (no standalone Python fetchers, no new UI/tRPC surface) are respected — no
  task adds a tRPC procedure or touches a script not invoked via BullMQ.
- **Type consistency:** `getLateJobs` returns `{ job, label, expectedAt, hoursLate, lastError }`
  in Task 2 and is consumed with those exact field names in Task 9's `checkAndAlertLateJobs`
  and `buildDailyDigest`. `JobScheduleEntry` fields (`jobName`, `cronPattern`, `everyMs`,
  `graceMinutes`, `critical`) are used identically across Tasks 1, 2, and 9.
