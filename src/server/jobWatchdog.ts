/**
 * Combines the two existing freshness signals — cron-aware job_heartbeat lateness
 * (jobHeartbeat.ts, for pure-BullMQ queues) and MONITOR_SCRIPTS/getSystemStatus
 * (monitor.router.ts, for the 20 Python-engine entries with real DB-freshness checks) —
 * into one Telegram watchdog + daily digest. Both sources are checked in real time by the
 * 15-minute watchdog (checkAndAlertLateJobs + checkAndAlertStaleScripts), in addition to
 * appearing in the once-daily digest. Deliberately does not introduce a third job registry:
 * see docs/superpowers/specs/2026-07-02-job-monitoring-telegram-alerts-design.md.
 */
import { getLateJobs, wasAlreadyAlerted, markAlerted } from './jobHeartbeat';
import { JOB_REGISTRY } from './jobRegistry';
import { getSystemStatus } from './routers/monitor.router';
import { telegramService, sanitizeMarkdown } from './telegramService';
import { dbGet, dbRun } from './dbAsync';
import { runDataQualityChecks, getLatestDataQualityResults } from './dataQualityChecks';

export async function checkAndAlertLateJobs(now: Date = new Date()): Promise<void> {
  const late = await getLateJobs(now);
  const registryByName = new Map(JOB_REGISTRY.map(j => [j.jobName, j]));

  for (const item of late) {
    const entry = registryByName.get(item.job);
    if (!entry?.critical) continue;
    if (await wasAlreadyAlerted(item.job, item.expectedAt)) continue;

    // Wrapped in backticks (inline code), but the message-level entity is still unbalanced if
    // the error text itself contains a stray backtick/underscore/asterisk -- sanitize regardless.
    const errorLine = item.lastError ? `\nLast error: \`${sanitizeMarkdown(item.lastError.slice(0, 300))}\`` : '';
    const text = `⚠️ *Job running late*: \`${sanitizeMarkdown(item.label)}\`\nExpected by ~${item.expectedAt.toISOString()} (${item.hoursLate}h late)${errorLine}`;
    await telegramService.sendMarkdownMessage(text);
    await markAlerted(item.job, item.expectedAt.getTime());
  }
}

/**
 * Real-time counterpart to the daily digest's "ML/data engines" section: alerts
 * immediately (next 15-min poll) when a critical MONITOR_SCRIPTS entry goes stale or
 * failed, instead of waiting for the once-daily digest. Scripts don't have a cron
 * "expected fire time" the way JOB_REGISTRY jobs do, so dedupe by calendar day (UTC)
 * instead — reusing wasAlreadyAlerted/markAlerted's existing last_alert_sent_at column
 * with the start of today as the "occurrence" key means at most one alert per script per
 * day, keyed by MONITOR_SCRIPTS id (which never collides with a JOB_REGISTRY jobName).
 */
export async function checkAndAlertStaleScripts(now: Date = new Date()): Promise<void> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const statuses = await getSystemStatus(now);
  for (const s of statuses) {
    if (!s.critical) continue;
    if (s.runState !== 'stale' && s.runState !== 'failed') continue;
    if (await wasAlreadyAlerted(s.id, startOfToday)) continue;

    const errorLine = s.error ? `\nLast error: \`${sanitizeMarkdown(String(s.error).slice(0, 300))}\`` : '';
    const text = `⚠️ *Critical engine ${s.runState}*: \`${sanitizeMarkdown(s.label)}\`\nLast run: ${s.lastRunAt ?? 'never'}${errorLine}`;
    await telegramService.sendMarkdownMessage(text);
    await markAlerted(s.id, startOfToday.getTime());
  }
}

/**
 * Data-quality counterpart to checkAndAlertStaleScripts: MONITOR_SCRIPTS/JOB_REGISTRY only
 * know whether a job *ran*; dataQualityChecks.ts asks whether what it wrote is actually
 * correct/complete (see that module's header for the class of bug this exists to catch).
 * This is the only place that actually re-runs the checks (buildDailyDigest below just
 * reads what this already persisted) — dedupes alerts by calendar day (UTC) the same way,
 * reusing markAlerted/wasAlreadyAlerted keyed by check id, so a persistently-failing check
 * pages once per day, not every 15 minutes.
 */
export async function checkAndAlertDataQuality(now: Date = new Date()): Promise<void> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const results = await runDataQualityChecks(now);
  for (const r of results) {
    if (!r.critical) continue;
    if (r.status !== 'fail' && r.status !== 'error') continue;
    if (await wasAlreadyAlerted(r.id, startOfToday)) continue;

    const icon = r.status === 'error' ? '⛔' : '🚨';
    // r.detail routinely embeds raw snake_case table names (e.g. "mf_sector_allocation is
    // empty") -- the underscores are unbalanced Markdown entities to Telegram's legacy
    // parser and silently killed the whole message (confirmed live 2026-08-04, 08:40 IST,
    // matching this check's own cron).
    const text = `${icon} *Data quality ${r.status}*: \`${sanitizeMarkdown(r.label)}\`\n${sanitizeMarkdown(r.detail)}`;
    await telegramService.sendMarkdownMessage(text);
    await markAlerted(r.id, startOfToday.getTime());
  }
}

const DIGEST_STATE_KEY = 'job_digest_last_state';

async function loadDigestState(): Promise<Record<string, string>> {
  try {
    const row = await dbGet<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [DIGEST_STATE_KEY]);
    return row?.value ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

async function saveDigestState(state: Record<string, string>): Promise<void> {
  try {
    await dbRun(
      'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [DIGEST_STATE_KEY, JSON.stringify(state)],
    );
  } catch (err) {
    console.warn('[WATCHDOG] saveDigestState failed:', (err as Error).message);
  }
}

const scriptIcon = (state: string) => state === 'success' ? '✅' : state === 'stale' ? '⚠️' : state === 'failed' ? '❌' : '⏳';
const dqIcon = (state: string) => state === 'pass' ? '✅' : state === 'warn' ? '⚠️' : state === 'fail' ? '❌' : '⛔';

/**
 * Incremental digest: instead of re-listing all ~45 tracked jobs every time (mostly unchanged
 * day to day, and noisy to read on Telegram), this reports (1) whatever is CURRENTLY a problem
 * (late/stale/failed/data-quality-fail — so nothing silently persists unmentioned), (2) whatever
 * CHANGED state since the last time the digest ran (recoveries and new problems), and (3) a
 * one-line count of everything else that's healthy and unchanged. State is persisted in
 * app_settings so the next run can diff against it. Data-quality results are read via
 * getLatestDataQualityResults() (already kept fresh by checkAndAlertDataQuality's 15-min poll)
 * rather than re-run here, so the digest doesn't duplicate that DB work or its persistence.
 */
export async function buildDailyDigest(now: Date = new Date()): Promise<string> {
  const late = await getLateJobs(now);
  const lateByName = new Map(late.map(l => [l.job, l]));
  const scheduledRegistry = JOB_REGISTRY.filter(j => j.cronPattern || j.everyMs);
  const eventDriven = JOB_REGISTRY.filter(j => !j.cronPattern && !j.everyMs);
  const scriptStatuses = await getSystemStatus(now);
  const dqResults = await getLatestDataQualityResults();

  const prevState = await loadDigestState();
  const currState: Record<string, string> = {};
  const attention: string[] = [];
  const changed: string[] = [];
  let unchangedHealthy = 0;

  for (const j of scheduledRegistry) {
    const key = `registry:${j.jobName}`;
    const lateEntry = lateByName.get(j.jobName);
    const state = lateEntry ? 'late' : 'ontime';
    currState[key] = state;
    const prev = prevState[key];

    if (state === 'late') attention.push(`⚠️ ${j.label} (~${lateEntry!.hoursLate}h late)`);

    if (prev === undefined) continue; // first time this key is tracked — nothing to diff yet
    if (prev !== state) {
      changed.push(state === 'ontime' ? `✅ ${j.label} — recovered` : `⚠️ ${j.label} — newly late`);
    } else if (state === 'ontime') {
      unchangedHealthy++;
    }
  }

  for (const s of scriptStatuses as any[]) {
    const key = `script:${s.id}`;
    const state: string = s.runState;
    currState[key] = state;
    const prev = prevState[key];
    const isProblem = state === 'stale' || state === 'failed';

    if (isProblem) {
      attention.push(`${scriptIcon(state)} ${s.label} (${state}, last: ${s.lastRunAt ?? 'never'})`);
    }

    if (prev === undefined) continue;
    if (prev !== state) {
      const wasProblem = prev === 'stale' || prev === 'failed';
      if (wasProblem && !isProblem) changed.push(`✅ ${s.label} — recovered (was ${prev})`);
      else if (!wasProblem && isProblem) changed.push(`${scriptIcon(state)} ${s.label} — newly ${state}`);
      // routine transitions (never→running→success etc.) aren't worth a line
    } else if (state === 'success') {
      unchangedHealthy++;
    }
  }

  for (const r of dqResults) {
    const key = `dq:${r.id}`;
    const state = r.status;
    currState[key] = state;
    const prev = prevState[key];
    const isProblem = state === 'fail' || state === 'error';

    if (isProblem) {
      // r.detail routinely embeds raw snake_case table names -- same unbalanced-entity failure
      // as checkAndAlertDataQuality above, but here inside one single joined message, so an
      // unsanitized detail anywhere in this loop kills the whole digest, not just one line.
      attention.push(`${dqIcon(state)} ${sanitizeMarkdown(r.label)} — ${sanitizeMarkdown(r.detail)}`);
    }

    if (prev === undefined) continue;
    if (prev !== state) {
      const wasProblem = prev === 'fail' || prev === 'error';
      if (wasProblem && !isProblem) changed.push(`✅ ${sanitizeMarkdown(r.label)} — recovered (was ${prev})`);
      else if (!wasProblem && isProblem) changed.push(`${dqIcon(state)} ${sanitizeMarkdown(r.label)} — newly ${state}: ${sanitizeMarkdown(r.detail)}`);
      // pass<->warn transitions aren't worth a line
    } else if (state === 'pass') {
      unchangedHealthy++;
    }
  }

  await saveDigestState(currState);

  const lines = [`📋 *Daily Job Health Digest* — ${now.toISOString().slice(0, 10)}`, ''];

  if (attention.length) {
    lines.push(`*Needs attention (${attention.length}):*`, ...attention, '');
  }
  if (changed.length) {
    lines.push(`*Changed since last report (${changed.length}):*`, ...changed, '');
  }
  if (!attention.length && !changed.length) {
    lines.push('✅ Nothing changed since the last report — all jobs on schedule.', '');
  }
  lines.push(`_${unchangedHealthy} other job(s) healthy and unchanged._`);

  if (eventDriven.length) {
    lines.push('', '*Event-driven (no fixed schedule):*', ...eventDriven.map(j => `⏳ ${j.label}`));
  }

  return lines.join('\n');
}

export function startJobWatchdog(): void {
  const check = async () => {
    try {
      await checkAndAlertLateJobs();
    } catch (err) {
      console.error('[WATCHDOG] checkAndAlertLateJobs failed:', (err as Error).message);
    }
    try {
      await checkAndAlertStaleScripts();
    } catch (err) {
      console.error('[WATCHDOG] checkAndAlertStaleScripts failed:', (err as Error).message);
    }
    try {
      await checkAndAlertDataQuality();
    } catch (err) {
      console.error('[WATCHDOG] checkAndAlertDataQuality failed:', (err as Error).message);
    }
  };
  setInterval(() => { void check(); }, 15 * 60 * 1000).unref();
  console.log('[WATCHDOG] Job lateness watchdog started (every 15 min).');
}
