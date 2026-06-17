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
import db from './db';

db.exec(`CREATE TABLE IF NOT EXISTS job_heartbeat (
  job_name        TEXT PRIMARY KEY,
  last_status     TEXT,
  last_run_at     INTEGER,
  last_success_at INTEGER,
  last_error      TEXT,
  run_count       INTEGER DEFAULT 0,
  fail_count      INTEGER DEFAULT 0
)`);

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

const _upsert = db.prepare(`
  INSERT INTO job_heartbeat (job_name, last_status, last_run_at, last_success_at, last_error, run_count, fail_count)
  VALUES (@name, @status, @now, @successAt, @error, 1, @failInc)
  ON CONFLICT(job_name) DO UPDATE SET
    last_status     = @status,
    last_run_at     = @now,
    last_success_at = CASE WHEN @status = 'success' THEN @now ELSE job_heartbeat.last_success_at END,
    last_error      = @error,
    run_count       = job_heartbeat.run_count + 1,
    fail_count      = job_heartbeat.fail_count + @failInc
`);

export function recordHeartbeat(jobName: string, status: 'success' | 'failed', error?: string): void {
  try {
    const now = Date.now();
    _upsert.run({
      name: jobName,
      status,
      now,
      successAt: status === 'success' ? now : null,
      error: error ?? null,
      failInc: status === 'failed' ? 1 : 0,
    });
  } catch {
    // Heartbeat must never break a job.
  }
}

export function getStaleJobs(): Array<{ job: string; hoursStale: number }> {
  const now = Date.now();
  const rows = db.prepare('SELECT job_name, last_success_at FROM job_heartbeat').all() as
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
  const check = () => {
    const stale = getStaleJobs();
    for (const s of stale) {
      console.warn(`[HEARTBEAT] STALE: '${s.job}' has not succeeded in ~${s.hoursStale}h`);
    }
  };
  setInterval(check, 60 * 60 * 1000).unref();
  console.error('[HEARTBEAT] Job staleness monitor started (hourly).');
}
