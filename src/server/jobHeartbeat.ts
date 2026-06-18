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

// This module is the sole creator of job_heartbeat on both engines (it is not in db.ts
// nor the generated PG schema). The CREATE runs once, memoized, and every public fn
// awaits it before its first query — so there is no create-vs-query race now that the
// data layer is async.
// last_run_at / last_success_at hold epoch-ms (~1.7e12) which overflows Postgres'
// 32-bit INTEGER — use BIGINT (SQLite treats BIGINT as 64-bit INTEGER affinity, so the
// same DDL is correct on both engines).
const HEARTBEAT_DDL = `CREATE TABLE IF NOT EXISTS job_heartbeat (
  job_name        TEXT PRIMARY KEY,
  last_status     TEXT,
  last_run_at     BIGINT,
  last_success_at BIGINT,
  last_error      TEXT,
  run_count       INTEGER DEFAULT 0,
  fail_count      INTEGER DEFAULT 0
)`;

let _tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!_tableReady) _tableReady = dbExec(HEARTBEAT_DDL).catch(() => { /* already exists / DB not ready */ });
  return _tableReady;
}

// Expected max age (ms) between successful runs, per job. Anything not listed defaults
// to 26h (covers daily jobs with slack). Tune as cadences change.
const STALE_THRESHOLD_MS: Record<string, number> = {
  'stock-refresh':    30 * 60 * 1000,        // every 5 min during market hours
  'outcome-resolver': 26 * 60 * 60 * 1000,   // daily
  'ml-daily-ops':     26 * 60 * 60 * 1000,   // daily
  'stock-scoring':    26 * 60 * 60 * 1000,   // daily
  'news-sentiment':   2 * 60 * 60 * 1000,    // every 5 min, allow slack
  'confluence-compute': 2 * 60 * 60 * 1000,
};
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
  const rows = await dbAll('SELECT job_name, last_success_at FROM job_heartbeat') as
    Array<{ job_name: string; last_success_at: number | null }>;
  const stale: Array<{ job: string; hoursStale: number }> = [];
  for (const r of rows) {
    const thr = STALE_THRESHOLD_MS[r.job_name] ?? DEFAULT_STALE_MS;
    const last = r.last_success_at ?? 0;
    if (now - last > thr) stale.push({ job: r.job_name, hoursStale: Math.floor((now - last) / 3_600_000) });
  }
  return stale;
}

/** Periodically log stale jobs. Returns the timer so callers may unref it. */
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
