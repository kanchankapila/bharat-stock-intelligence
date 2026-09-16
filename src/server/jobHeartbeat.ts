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
import { JOB_REGISTRY, HOLIDAY_ACTIVE_JOB_NAMES } from './jobRegistry';
import { MONITOR_SCRIPTS } from './monitorScripts';
import { DATA_QUALITY_CHECKS, tradingDaysStale } from './dataQualityChecks';
import { isTradingHolidayToday } from './marketStatusService';

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
//
// 2026-08-30: this flat calendar threshold false-positived every weekend for every step of
// ml-daily-ops (event-triggers, online-learner, breakout-classifier-train,
// movement-predictor-train, ...) plus mover-screener-capture/mover-intraday-capture --
// all Mon-Fri-only jobs whose T.run() sub-steps write their OWN job_heartbeat row (unlike
// their parent 'ml-daily-ops', which IS in JOB_REGISTRY and correctly skipped here). A Friday
// success read on Sunday morning is only ~1 day of REAL staleness once the weekend is
// subtracted, but 26h flat already trips on Saturday morning. Same class as recurring-bugs.md's
// "Raw daysStale() reads Monday as 3 days stale -- use tradingDaysStale()", just in this
// fallback bucket instead of a dataQualityChecks.ts freshness check. Compared via
// tradingDaysStale() below instead of the raw ms delta.
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

/**
 * Duration of a BullMQ job from its own processedOn/finishedOn timestamps.
 *
 * recordHeartbeat() is the write chokepoint for job_run_history but cannot derive a duration
 * itself -- it only ever receives a name and a status. The ~44 hand-wired worker handlers in
 * queues.ts DO hold the job, and BullMQ already timestamps it, so the duration is free at the
 * call site with no timer threaded through anything. Measured 2026-09-05 before this existed:
 * duration_ms was populated on 21 of 432 rows (4.9%), i.e. runtime tracking was effectively
 * absent for every job not migrated onto registerRepeatableJob().
 *
 * Returns undefined rather than throwing for a job BullMQ never loaded -- it passes `undefined`
 * to a 'failed' handler in that case, and a throw there would convert a recorded failure into a
 * lost one. A genuine 0 is preserved: coercing it to undefined would drop the fastest jobs from
 * every statistic, and those are exactly the ones most likely to be silently no-opping.
 */
export function bullJobDurationMs(
  job: { processedOn?: number | null; finishedOn?: number | null } | undefined | null,
): number | undefined {
  const started = job?.processedOn;
  const finished = job?.finishedOn;
  if (typeof started !== 'number' || typeof finished !== 'number') return undefined;
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  const d = finished - started;
  return d >= 0 ? d : undefined;
}

export async function recordHeartbeat(
  jobName: string, status: 'success' | 'failed', error?: string, durationMs?: number,
): Promise<void> {
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
    // duration_ms (added 2026-09-04, scheduler-review finding): nullable -- most call sites
    // still pass none, so a caller with no cheap start time is unaffected, not broken.
    try {
      await dbRun(
        `INSERT INTO job_run_history (job_name, status, ran_at, error, duration_ms) VALUES (?, ?, to_timestamp(? / 1000.0), ?, ?)`,
        [jobName, status, now, err, durationMs ?? null],
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
    // 'deploy-drift' and 'port-drift': their pm2 cron_restart apps were deliberately removed
    // from ecosystem.config.cjs 2026-08-27 (`b27e588`, user-requested) and their DATA_QUALITY_CHECKS
    // entries were then removed 2026-08-29 (AF-20260829-17, see dataQualityChecks.ts) because a
    // checker for a deliberately-unscheduled job is structurally guaranteed to fail forever. That
    // fix removed them from `dataQualityIds` above too, as a side effect -- so their existing
    // job_heartbeat rows (never deleted; scripts/check_{deploy,port}_drift.mjs are left runnable
    // manually) fell through into this generic 26h-staleness check and started logging a fresh
    // "STALE" warning every hour, forever, for monitoring this session intentionally turned off.
    // Same bug class as recurring-bugs.md's "deleting a thing does not delete the checks pointing
    // at it" -- exclude explicitly here too, matching the exclusion already applied in
    // dataQualityChecks.ts's own read path.
    // gdelt-sentiment: retired 2026-09-11 (queues.ts) -- its heartbeat row would otherwise read
    // as STALE here every hour, forever.
    const decommissionedJobs = new Set(['deploy-drift', 'port-drift', 'dl-inference', 'gdelt-sentiment']);

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
      if (decommissionedJobs.has(r.job_name)) continue;
      if (r.last_success_at == null) {
        // Never succeeded — no epoch to measure staleness against; "?? 0" here would
        // report "hours since 1970" (~495,000h) instead of the real signal, which is
        // just "this job has never once completed successfully."
        stale.push({ job: r.job_name, hoursStale: null });
        continue;
      }
      if (now - r.last_success_at > DEFAULT_STALE_MS) {
        const tradingDays = tradingDaysStale(new Date(r.last_success_at), new Date(now)) ?? 0;
        if (tradingDays * 86_400_000 > DEFAULT_STALE_MS) {
          stale.push({ job: r.job_name, hoursStale: Math.floor((now - r.last_success_at) / 3_600_000) });
        }
      }
    }
    return stale;
  } catch (error) {
    console.error('[HEARTBEAT] getStaleJobs failed:', error);
    return [];
  }
}

// ── Holiday-aware session window (added 2026-09-14) ─────────────────────────────
// The lateness math below is cron-blind to NSE trading holidays: every weekday-only
// job in the holiday-skip family returns { skipped: true } on a closed day, and a
// skip is deliberately NOT stamped as a success (registerJob.ts's completed handler;
// see HOLIDAY_SKIP_NOTE at the foot of confluence.jobs.ts) — so on those days the
// heartbeat shows no success since the last real session, and getLateJobs()/
// computeCronLateness() flagged the whole family "late" in the digest and the 15-min
// watchdog on exactly the days they were correctly idle. That phantom-delay class is
// what this window exists to forgive.
//
// The exchange's own record is authoritative, so the session calendar comes from the
// same source as_of.py's trading_days_back() uses: distinct recent stock_ohlcv dates
// (that table holds ONLY real sessions — special Saturday sessions included), with a
// 6-day freshness guard: a newest-session older than that means the EOD writes
// themselves have stalled, which is a real outage the lateness check must KEEP
// reporting, not a holiday to forgive. Fail-open to the old cron-only behavior
// whenever the window cannot be built. Cached 15 min — the 15-min watchdog, the
// twice-daily digests and getSystemStatus() all ask for it.
export interface TradingSessionWindow {
  /** IST date (YYYY-MM-DD) of the OLDEST session in the window. */
  oldest: string;
  /** IST date (YYYY-MM-DD) of the NEWEST session in the window. */
  newest: string;
  /** Every observed session date (IST, YYYY-MM-DD) in the window. */
  dates: Set<string>;
  /**
   * Every IST date in [oldest, today] the exchange provably never opened — the holidays
   * this module exists to forgive. Precomputed per window because the evidence differs
   * by band and the verdict at judgment time must stay a cheap sync lookup:
   *  - [oldest, newest]: weekday dates absent from `dates`. stock_ohlcv only ever holds
   *    real sessions, and reconcile-stock-ohlcv (nightly ml-daily-ops step) backfills any
   *    real session its first write missed from bhavcopy — so an unbackfilled gap inside
   *    the observed window IS a closed day.
   *  - (newest, today): ambiguous — could be a holiday or a session whose EOD write
   *    simply hasn't landed yet (ohlcv lands ~16:00 IST). Resolved with technical_signals
   *    (technical-scan writes it from 08:30 IST on every real session, nothing on a
   *    holiday — lag-free inside the market day): a weekday in this band with NO
   *    technical_signals row is a holiday; one WITH rows is a real session whose EOD
   *    write is pending, and lateness must keep judging it normally.
   *  - today: answered by the live holiday feed (exact for today, fail-open to false on
   *    a fetch error), never by absent writes — the 00:00–08:30 IST band must not mask
   *    a failed post-midnight job just because the session's writes haven't started.
   */
  idleDates: Set<string>;
}

const SESSIONS_CACHE_TTL_MS = 15 * 60_000;
// 10 sessions ≈ 12+ calendar days; a sessionless weekday INSIDE the window is a
// holiday, one OLDER than it is simply unobserved (unknown ≠ forgiven).
const SESSIONS_WINDOW = 10;
const MAX_SESSIONS_AGE_DAYS = 6;

let _sessionsCache: { window: TradingSessionWindow | null; at: number } | null = null;

/** Test seam: the cache is per-process, so a test that swaps the dbAll fixture must
 *  start cold (mirrors registerJob.ts's __resetMonitorNames). */
export function __resetTradingSessionCache(): void {
  _sessionsCache = null;
}

export function istDateStr(t: number): string {
  return new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function istIsWeekday(t: number): boolean {
  const d = new Date(t + 5.5 * 3600_000).getUTCDay(); // 0=Sun, 6=Sat
  return d >= 1 && d <= 5;
}

/** Splits the ambiguous gap band (newest, today, both exclusive) into:
 *  - `scanned`: weekday dates technical-scan DID write (technical_signals rows exist —
 *    real sessions whose ~16:00-IST ohlcv EOD write is missing or pending);
 *  - `idle`: weekday dates it never wrote (the exchange never opened — holidays).
 *  technical-scan writes that table from 08:30 IST on every real session, so inside the
 *  market day this probe is lag-free — exactly where stock_ohlcv's own EOD write is too
 *  slow to distinguish a holiday from a pending write. Probe failure fails open: empty
 *  sets, no verdicts either way (the lateness math keeps the pre-fix behavior). */
async function probeIdleGapDates(newest: string, todayIst: string): Promise<{ scanned: Set<string>; idle: Set<string> }> {
  try {
    const rows = await dbAll(
      `SELECT DISTINCT date::text AS d FROM technical_signals
       WHERE date::text > ? AND date::text < ? LIMIT 20`,
      [newest, todayIst],
    ) as Array<{ d?: string | null }>;
    const scanned = new Set(
      (rows ?? [])
        .map(r => String(r?.d ?? '').slice(0, 10))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    );
    const idle = new Set<string>();
    for (
      let d = new Date(`${newest}T00:00:00Z`);
      d < new Date(`${todayIst}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const iso = d.toISOString().slice(0, 10);
      if (istIsWeekday(d.getTime()) && !scanned.has(iso)) idle.add(iso);
    }
    return { scanned, idle };
  } catch {
    return { scanned: new Set<string>(), idle: new Set<string>() };
  }
}

export async function getRecentTradingSessions(now: Date = new Date()): Promise<TradingSessionWindow | null> {
  if (_sessionsCache && now.getTime() - _sessionsCache.at < SESSIONS_CACHE_TTL_MS) {
    return _sessionsCache.window;
  }
  const window = await (async (): Promise<TradingSessionWindow | null> => {
    try {
      const rows = await dbAll(
        `SELECT DISTINCT date::text AS d FROM stock_ohlcv ORDER BY d DESC LIMIT ${SESSIONS_WINDOW}`,
      ) as Array<{ d?: string | null }>;
      const dates = (rows ?? [])
        .map(r => String(r?.d ?? '').slice(0, 10))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      if (!dates.length) return null;
      const newestMs = Date.parse(`${dates[0]}T10:00:00+05:30`);
      if (Number.isFinite(newestMs) && now.getTime() - newestMs > MAX_SESSIONS_AGE_DAYS * 86_400_000) return null;
      const oldest = dates[dates.length - 1];
      const newest = dates[0];
      const todayIst = istDateStr(now.getTime());
      const dateSet = new Set(dates);
      // Band 1 — holidays inside the observed window.
      const idleDates = new Set<string>();
      let d = new Date(`${oldest}T00:00:00Z`);
      const end = new Date(`${todayIst}T00:00:00Z`);
      for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        if (istIsWeekday(d.getTime()) && !dateSet.has(d.toISOString().slice(0, 10))) {
          idleDates.add(d.toISOString().slice(0, 10));
        }
      }
      // Band 2 — the ambiguous gap between the newest session and today: keep only the
      // dates the technical_signals probe proves the exchange never opened, and REMOVE
      // the ones it proves were real sessions (band 1 marked them idle purely because
      // their ohlcv write failed/hasn't landed — a write failure must not read as a
      // holiday, or every other job's genuine miss that day would be pardoned too).
      const gap = await probeIdleGapDates(newest, todayIst);
      for (const iso of gap.idle) idleDates.add(iso);
      for (const iso of gap.scanned) idleDates.delete(iso);
      // Band 3 — today: the live feed answers exactly (fail-open to NOT idle on error),
      // so a real session's early-morning hours are never mistaken for a holiday.
      const todayIdle = await isTradingHolidayToday().catch(() => false);
      if (todayIdle) idleDates.add(todayIst); else idleDates.delete(todayIst);
      return { oldest, newest, dates: dateSet, idleDates };
    } catch {
      return null;
    }
  })();
  _sessionsCache = { window, at: now.getTime() };
  return window;
}

/** True when every 5-field pattern's day-of-week field restricts it to weekdays
 *  (every listed day lands in 1-5). Forgiveness must ONLY apply to such patterns:
 *  a weekend-anchored weekly job ('0 2 * * 6' — nse-sync, fundamentals-sync,
 *  ml-weekly-retrain) has occurrences on days stock_ohlcv legitimately never holds,
 *  so forgiving those would pardon a genuinely missed weekly run forever; and a 24/7
 *  cadence (trendlyne-catchup's every-20-min cron; confluence-compute's every-day
 *  window patterns) keeps working on holidays, so its failures must keep alerting on
 *  one too. */
export function patternsAreWeekdayOnly(cronPatterns: string[]): boolean {
  return cronPatterns.every(p => {
    const fields = p.trim().split(/\s+/);
    const dow = fields[4];
    if (!dow || dow === '*') return false;
    return dow.split(',').every(tok => {
      const range = tok.match(/^(\d+)-(\d+)$/);
      const days = range
        ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
        : [Number(tok)];
      return days.every(n => Number.isInteger(n) && n >= 1 && n <= 5);
    });
  });
}

/** True when `expectedAt`'s IST calendar date is a weekday the exchange provably never
 *  opened — i.e. the job's skip that day was the PLANNED holiday behavior, not a miss.
 *  The provable-idle verdicts are precomputed into `sessions.idleDates` (see the field's
 *  doc for the per-band evidence); here only the cheap checks remain. Returns false
 *  whenever anything is uncertain: no session window (fail-open), a weekend date, or an
 *  occurrence older than the observed window. */
export function isDeliberatelyIdleOccurrence(expectedAt: Date, sessions: TradingSessionWindow | null): boolean {
  if (!sessions) return false;
  const t = expectedAt.getTime();
  if (!istIsWeekday(t)) return false;
  const d = istDateStr(t);
  if (d < sessions.oldest) return false; // older than the window: unobserved, not proven idle
  return sessions.idleDates.has(d);
}

/**
 * Checks if a cron pattern has any scheduled occurrence within the specified IST calendar date.
 * An IST day (e.g. 2026-09-14) spans from UTC (D-1) 18:30:00 to UTC D 18:29:59.999.
 */
export function hasOccurrenceOnIstDate(cronPattern: string, istDate: string): boolean {
  try {
    const [y, m, d] = istDate.split('-').map(Number);
    const endOfDayUtc = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 5.5 * 3600_000);
    const prev = CronExpressionParser.parse(cronPattern, { currentDate: endOfDayUtc, tz: 'Etc/UTC' }).prev().toDate();
    return istDateStr(prev.getTime()) === istDate;
  } catch {
    return false;
  }
}

/**
 * Returns true if a job entry is supposed to run on the specified IST date.
 * Accounts for day-of-week cron schedules, trading holidays, and weekend exclusions.
 */
export function isJobSupposedToRunOnDate(
  entry: {
    jobName: string;
    cronPattern?: string;
    everyMs?: number;
    lateDeadlineCronPatterns?: string[];
  },
  date: Date,
  isTradingHoliday: boolean,
): boolean {
  if (!entry.cronPattern && !entry.everyMs) return false; // event-driven, no fixed schedule
  const istDate = istDateStr(date.getTime());

  if (isTradingHoliday) {
    if (HOLIDAY_ACTIVE_JOB_NAMES?.has?.(entry.jobName)) {
      return entry.cronPattern ? hasOccurrenceOnIstDate(entry.cronPattern, istDate) : true;
    }
    // Weekday-only jobs skip on trading holidays
    if (entry.cronPattern && patternsAreWeekdayOnly([entry.cronPattern])) {
      return false;
    }
    // Intraday market-hours jobs with weekday deadlines skip on trading holidays
    if (entry.everyMs && entry.lateDeadlineCronPatterns && patternsAreWeekdayOnly(entry.lateDeadlineCronPatterns)) {
      return false;
    }
    if (entry.cronPattern) {
      return hasOccurrenceOnIstDate(entry.cronPattern, istDate);
    }
    return true; // 24/7 cadence (news-sentiment, confluence-compute, etc.)
  }

  // Regular (non-holiday) day
  if (entry.cronPattern) {
    return hasOccurrenceOnIstDate(entry.cronPattern, istDate);
  }

  // everyMs jobs
  const istDayOfWeek = new Date(date.getTime() + 5.5 * 3600_000).getUTCDay();
  // Intraday market-hours jobs skip on weekends
  if ((istDayOfWeek === 0 || istDayOfWeek === 6) && entry.lateDeadlineCronPatterns && patternsAreWeekdayOnly(entry.lateDeadlineCronPatterns)) {
    return false;
  }
  return true;
}

export interface JobTypicalDuration {
  avgMs: number;
  p95Ms: number;
  count: number;
}

let _durationsCache: { durations: Map<string, JobTypicalDuration>; at: number } | null = null;

export function __resetJobTypicalDurationsCache(): void {
  _durationsCache = null;
}

/**
 * Retrieves typical execution duration (avg and p95 ms) from job_run_history over the
 * past 14 days of successful runs, cached for 15 minutes.
 */
export async function getJobTypicalDurations(now: Date = new Date()): Promise<Map<string, JobTypicalDuration>> {
  if (_durationsCache && now.getTime() - _durationsCache.at < SESSIONS_CACHE_TTL_MS) {
    return _durationsCache.durations;
  }
  const durations = new Map<string, JobTypicalDuration>();
  try {
    const rows = await dbAll<{
      job_name: string;
      avg_ms: number | string | null;
      p95_ms: number | string | null;
      count: number | string;
    }>(
      `SELECT job_name,
              round(avg(duration_ms)) as avg_ms,
              round(percentile_cont(0.95) within group (order by duration_ms)) as p95_ms,
              count(*) as count
       FROM job_run_history
       WHERE status = 'success' AND duration_ms IS NOT NULL AND ran_at > now() - interval '14 days'
       GROUP BY job_name`
    );
    for (const r of (rows ?? [])) {
      if (!r?.job_name) continue;
      durations.set(r.job_name, {
        avgMs: Number(r.avg_ms ?? 0),
        p95Ms: Number(r.p95_ms ?? r.avg_ms ?? 0),
        count: Number(r.count ?? 0),
      });
    }
  } catch {
    // Fail-open to empty map (e.g. SQLite tests or table not ready)
  }
  _durationsCache = { durations, at: now.getTime() };
  return durations;
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
 *
 * `sessions` (optional) makes the verdict holiday-aware: when the most recent expected fire
 * lands on a weekday the exchange never opened — and the patterns themselves are weekday-only,
 * so 24/7 and weekend-anchored schedules can never be pardoned — the job was deliberately idle
 * and is NOT late regardless of the heartbeat. Pass getRecentTradingSessions()'s result; null
 * (window unavailable) keeps the pre-holiday-aware behavior.
 */
export function computeCronLateness(
  cronPatterns: string[],
  graceMinutes: number,
  lastSuccessMs: number | null,
  now: Date = new Date(),
  sessions: TradingSessionWindow | null = null,
): { late: boolean; expectedAt: Date } {
  let expectedAt: Date | null = null;
  for (const pattern of cronPatterns) {
    const prev = CronExpressionParser.parse(pattern, { currentDate: now, tz: 'Etc/UTC' }).prev().toDate();
    if (!expectedAt || prev > expectedAt) expectedAt = prev;
  }
  const deadline = expectedAt!.getTime() + graceMinutes * 60_000;
  if (now.getTime() < deadline) return { late: false, expectedAt: expectedAt! };
  if (sessions && patternsAreWeekdayOnly(cronPatterns) && isDeliberatelyIdleOccurrence(expectedAt!, sessions)) {
    // Trading holiday: the job was planned NOT to run today (its processor skipped and
    // declined the heartbeat by design). Not late.
    return { late: false, expectedAt: expectedAt! };
  }
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
    // Holiday window (see the header comment above): null = unknown = fail-open, the
    // pre-holiday-aware cron-only behavior. Cached 15 min across all callers.
    const sessions = await getRecentTradingSessions(now);
    const isTradingHoliday = isDeliberatelyIdleOccurrence(now, sessions);
    const typicalDurations = await getJobTypicalDurations(now).catch(() => new Map<string, JobTypicalDuration>());
    const rows = await dbAll(
      'SELECT job_name, last_success_at, last_error, last_alert_sent_at FROM job_heartbeat'
    ) as Array<{ job_name: string; last_success_at: number | null; last_error: string | null; last_alert_sent_at: number | null }>;
    const byName = new Map(rows.map(r => [r.job_name, r]));

    const late: Array<{ job: string; label: string; expectedAt: Date; hoursLate: number; lastError: string | null }> = [];
    for (const entry of JOB_REGISTRY) {
      // 1. Only evaluate jobs that are supposed to run on this IST date
      if (!isJobSupposedToRunOnDate(entry, now, isTradingHoliday)) {
        continue;
      }

      const row = byName.get(entry.jobName);
      const lastSuccess = row?.last_success_at ?? null;

      let expectedAt: Date;
      if (entry.lateDeadlineCronPatterns) {
        // See jobRegistry.ts's doc comment: computes lateness against the job's real work
        // window, not its cron's generous post-close tail slots.
        const result = computeCronLateness(entry.lateDeadlineCronPatterns, entry.graceMinutes, lastSuccess, now, sessions);
        if (!result.late) continue;
        expectedAt = result.expectedAt;
      } else if (entry.cronPattern) {
        const interval = CronExpressionParser.parse(entry.cronPattern, { currentDate: now, tz: 'Etc/UTC' });
        expectedAt = interval.prev().toDate();
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
      } else {
        continue; // event-driven, no schedule to be late against
      }

      // If scheduled time hasn't arrived yet today, it cannot be late yet
      if (expectedAt.getTime() > now.getTime()) continue;

      if ((lastSuccess ?? 0) >= expectedAt.getTime()) continue; // already succeeded for this occurrence

      // Trading holiday: the job's cron fired on a weekday the exchange never opened, the
      // processor skipped and declined the heartbeat BY DESIGN (registerJob.ts never stamps
      // a skip as a success) — the absent success is the planned behavior, not a miss.
      // Gated on weekday-only patterns so 24/7 cadences (trendlyne-catchup) and
      // weekend-anchored weekly jobs (nse-sync '0 2 * * 6') can never be pardoned, and on
      // HOLIDAY_ACTIVE_JOB_NAMES because closed-day-early-batch runs ON holidays (it is the
      // holiday dispatcher) — a genuine failure of it on the closed day must still alert.
      if (sessions && !HOLIDAY_ACTIVE_JOB_NAMES?.has?.(entry.jobName)
          && patternsAreWeekdayOnly([entry.cronPattern ?? '']) && isDeliberatelyIdleOccurrence(expectedAt, sessions)) continue;

      // 2. Delay check based on time it usually takes:
      // If duration history exists, use typical runtime (p95 or avg) plus a jitter buffer (at least 10m).
      // Fallback to entry.graceMinutes if no duration history exists.
      const durationInfo = typicalDurations.get(entry.jobName);
      const hasDurationHistory = durationInfo && durationInfo.count >= 2;
      const usualDurationMs = hasDurationHistory
        ? (durationInfo.p95Ms || durationInfo.avgMs)
        : (entry.graceMinutes * 60_000);

      const deadlineMs = hasDurationHistory
        ? (expectedAt.getTime() + usualDurationMs + Math.max(10 * 60_000, Math.round(usualDurationMs * 0.5)))
        : (expectedAt.getTime() + entry.graceMinutes * 60_000);

      // Still within the typical execution window + buffer: not delayed yet
      if (now.getTime() < deadlineMs) {
        continue;
      }

      const delayMs = hasDurationHistory
        ? Math.max(0, now.getTime() - (expectedAt.getTime() + usualDurationMs))
        : Math.max(0, now.getTime() - expectedAt.getTime());
      const hoursLate = Math.round((delayMs / 3_600_000) * 10) / 10;

      late.push({
        job: entry.jobName,
        label: entry.label,
        expectedAt,
        hoursLate,
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
