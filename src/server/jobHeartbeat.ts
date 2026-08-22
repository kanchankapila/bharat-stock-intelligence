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
import { MONITOR_SCRIPTS } from './monitorScripts';
import { DATA_QUALITY_CHECKS } from './dataQualityChecks';

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
  if (!_tableReady) {
    _tableReady = dbExec(HEARTBEAT_DDL)
      .catch(() => { /* already exists / DB not ready */ })
      // Self-heal a pre-existing job_heartbeat table (created before last_alert_sent_at
      // existed) — CREATE TABLE IF NOT EXISTS above is a no-op in that case, so add the
      // column here and swallow "duplicate column" the same way as "already exists".
      .then(() => dbExec('ALTER TABLE job_heartbeat ADD COLUMN last_alert_sent_at BIGINT'))
      .catch(() => { /* column already exists */ });
  }
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

    // Append the run-level row. job_heartbeat above keeps only LIFETIME counters, so a fail
    // rate computed from it can never be attributed to a time window -- i.e. it cannot answer
    // "is this still failing after the fix?". Written here rather than at each job's own call
    // site because every job already routes through this function; instrumenting the
    // chokepoint covers all of them instead of the ones someone remembers to add.
    // Separate try/catch on purpose: a failure appending history must not prevent the
    // heartbeat upsert above from being observed as written.
    try {
      await dbRun(
        `INSERT INTO job_run_history (job_name, status, ran_at, error) VALUES (?, ?, to_timestamp(? / 1000.0), ?)`,
        [jobName, status, now, err],
      );
    } catch { /* history is diagnostic; never break a job for it */ }
  } catch {
    // Heartbeat must never break a job.
  }
}

export async function getStaleJobs(): Promise<Array<{ job: string; hoursStale: number | null }>> {
  try {
    await ensureTable();
    const now = Date.now();
    const registryNames = new Set(JOB_REGISTRY.map(j => j.jobName));
    const monitorScriptIds = new Set(MONITOR_SCRIPTS.map(s => s.id as string));
    const dataQualityIds = new Set(DATA_QUALITY_CHECKS.map(c => c.id));
    const rows = await dbAll('SELECT job_name, last_success_at FROM job_heartbeat') as
      Array<{ job_name: string; last_success_at: number | null }>;
    const stale: Array<{ job: string; hoursStale: number | null }> = [];
    for (const r of rows) {
      if (registryNames.has(r.job_name)) continue; // covered by cron-aware getLateJobs() instead
      if (monitorScriptIds.has(r.job_name)) continue; // covered by getSystemStatus() instead
      // markAlerted() inserts a job_heartbeat row keyed by check id to dedupe Telegram
      // alerts for failing data-quality checks (checkAndAlertDataQuality in jobWatchdog.ts).
      // recordHeartbeat() is never called with these ids, so last_success_at is permanently
      // NULL — without this exclusion every DQ check that has ever failed once logs
      // "has never succeeded" here forever, even after it starts passing again, duplicating
      // the check's own real freshness signal in data_quality_results/getLatestDataQualityResults().
      if (dataQualityIds.has(r.job_name)) continue;
      if (r.last_success_at == null) {
        // Never succeeded — no epoch to measure staleness against; "?? 0" here would
        // report "hours since 1970" (~495,000h) instead of the real signal, which is
        // just "this job has never once completed successfully."
        stale.push({ job: r.job_name, hoursStale: null });
        continue;
      }
      if (now - r.last_success_at > DEFAULT_STALE_MS) {
        stale.push({ job: r.job_name, hoursStale: Math.floor((now - r.last_success_at) / 3_600_000) });
      }
    }
    return stale;
  } catch (error) {
    console.error('[HEARTBEAT] getStaleJobs failed:', error);
    return [];
  }
}

/**
 * Cron-aware lateness for an arbitrary set of contributing cron patterns (a script fed by
 * more than one queue, e.g. outcome-resolver-5d is touched by both the 9:30am resolver queue
 * and the 7:30pm ml-daily-ops batch, uses the MOST RECENT of the two expected fire times).
 * Mirrors getLateJobs()'s single-pattern logic below, generalized to N patterns, so MONITOR_SCRIPTS
 * entries (monitor.router.ts's getSystemStatus) can share the same "not late until its own
 * schedule's grace window has passed" semantics that JOB_REGISTRY jobs already get — instead of
 * a flat hours-since-last-success threshold that false-flags "stale" every time it's checked
 * before that day's/week's run has had a chance to fire (see docs on the Monday-morning /
 * pre-evening-batch false positives this was written to fix).
 */
export function computeCronLateness(
  cronPatterns: string[],
  graceMinutes: number,
  lastSuccessMs: number | null,
  now: Date = new Date(),
): { late: boolean; expectedAt: Date } {
  let expectedAt: Date | null = null;
  for (const pattern of cronPatterns) {
    const prev = CronExpressionParser.parse(pattern, { currentDate: now, tz: 'Etc/UTC' }).prev().toDate();
    if (!expectedAt || prev > expectedAt) expectedAt = prev;
  }
  const deadline = expectedAt!.getTime() + graceMinutes * 60_000;
  if (now.getTime() < deadline) return { late: false, expectedAt: expectedAt! };
  return { late: (lastSuccessMs ?? 0) < expectedAt!.getTime(), expectedAt: expectedAt! };
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
  try {
    await ensureTable();
    const rows = await dbAll(
      'SELECT job_name, last_success_at, last_error, last_alert_sent_at FROM job_heartbeat'
    ) as Array<{ job_name: string; last_success_at: number | null; last_error: string | null; last_alert_sent_at: number | null }>;
    const byName = new Map(rows.map(r => [r.job_name, r]));

    const late: Array<{ job: string; label: string; expectedAt: Date; hoursLate: number; lastError: string | null }> = [];
    for (const entry of JOB_REGISTRY) {
      const row = byName.get(entry.jobName);
      const lastSuccess = row?.last_success_at ?? null;

      let expectedAt: Date;
      if (entry.lateDeadlineCronPatterns) {
        // See jobRegistry.ts's doc comment: computes lateness against the job's real work
        // window, not its cron's generous post-close tail slots.
        const result = computeCronLateness(entry.lateDeadlineCronPatterns, entry.graceMinutes, lastSuccess, now);
        if (!result.late) continue;
        expectedAt = result.expectedAt;
      } else if (entry.cronPattern) {
        const interval = CronExpressionParser.parse(entry.cronPattern, { currentDate: now, tz: 'Etc/UTC' });
        expectedAt = interval.prev().toDate();
        const deadline = expectedAt.getTime() + entry.graceMinutes * 60_000;
        if (now.getTime() < deadline) continue; // not late yet
        if ((lastSuccess ?? 0) >= expectedAt.getTime()) continue; // already succeeded for this occurrence
      } else if (entry.everyMs) {
        // Anchor on the most recent boundary whose grace has ALREADY expired, not the current
        // one. Anchoring on the current boundary made this branch VACUOUS whenever graceMinutes
        // exceeded the cadence: `now - boundary` is by construction < everyMs, so a 45-minute
        // grace against a 15- or 30-minute cadence put the deadline permanently in the future
        // and `now < deadline` short-circuited on every call. Measured 2026-08-17: all three
        // everyMs entries were in that state, and a heartbeat seeded 7 MONTHS stale still
        // reported late=false for news-sentiment (critical) and trendlyne-intraday.
        const boundary = Math.floor(
          (now.getTime() - entry.graceMinutes * 60_000) / entry.everyMs,
        ) * entry.everyMs;
        expectedAt = new Date(boundary);
        if ((lastSuccess ?? 0) >= expectedAt.getTime()) continue; // already succeeded for this occurrence
      } else {
        continue; // event-driven, no schedule to be late against
      }

      late.push({
        job: entry.jobName,
        label: entry.label,
        expectedAt,
        hoursLate: Math.round(((now.getTime() - expectedAt.getTime()) / 3_600_000) * 10) / 10,
        lastError: row?.last_error ?? null,
      });
    }
    return late;
  } catch (error) {
    console.error('[HEARTBEAT] getLateJobs failed:', error);
    return [];
  }
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
  try {
    await ensureTable();
    const row = await dbAll(
      'SELECT last_alert_sent_at FROM job_heartbeat WHERE job_name = ?', [jobName]
    ) as Array<{ last_alert_sent_at: number | null }>;
    const sentAt = row[0]?.last_alert_sent_at ?? 0;
    return sentAt >= expectedAt.getTime();
  } catch (error) {
    console.error('[HEARTBEAT] wasAlreadyAlerted failed:', error);
    return false;
  }
}

/** Periodically log stale jobs (jobs NOT in JOB_REGISTRY — e.g. MONITOR_SCRIPTS-bridged
 * ones already have their own freshness check via getSystemStatus(), and DATA_QUALITY_CHECKS
 * ids already have their own freshness check via getLatestDataQualityResults()). */
export function startHeartbeatMonitor(): void {
  const check = async () => {
    const stale = await getStaleJobs();
    for (const s of stale) {
      if (s.hoursStale == null) {
        console.warn(`[HEARTBEAT] STALE: '${s.job}' has never succeeded`);
        continue;
      }
      console.warn(`[HEARTBEAT] STALE: '${s.job}' has not succeeded in ~${s.hoursStale}h`);
    }
  };
  setInterval(() => { void check(); }, 60 * 60 * 1000).unref();
  console.log('[HEARTBEAT] Job staleness monitor started (hourly).');
}
