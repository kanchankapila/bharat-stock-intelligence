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
import { telegramService } from './telegramService';
import { runDataQualityChecks } from './dataQualityChecks';

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
  const statuses = await getSystemStatus();
  for (const s of statuses) {
    if (!s.critical) continue;
    if (s.runState !== 'stale' && s.runState !== 'failed') continue;
    if (await wasAlreadyAlerted(s.id, startOfToday)) continue;

    const errorLine = s.error ? `\nLast error: \`${String(s.error).slice(0, 300)}\`` : '';
    const text = `⚠️ *Critical engine ${s.runState}*: \`${s.label}\`\nLast run: ${s.lastRunAt ?? 'never'}${errorLine}`;
    await telegramService.sendMarkdownMessage(text);
    await markAlerted(s.id, startOfToday.getTime());
  }
}

/**
 * Data-quality counterpart to checkAndAlertStaleScripts: MONITOR_SCRIPTS/JOB_REGISTRY only
 * know whether a job *ran*; dataQualityChecks.ts asks whether what it wrote is actually
 * correct/complete (see that module's header for the class of bug this exists to catch).
 * Dedupes by calendar day (UTC) the same way — reusing markAlerted/wasAlreadyAlerted keyed
 * by check id, so a persistently-failing check pages once per day, not every 15 minutes.
 */
export async function checkAndAlertDataQuality(now: Date = new Date()): Promise<void> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const results = await runDataQualityChecks(now);
  for (const r of results) {
    if (!r.critical) continue;
    if (r.status !== 'fail' && r.status !== 'error') continue;
    if (await wasAlreadyAlerted(r.id, startOfToday)) continue;

    const icon = r.status === 'error' ? '⛔' : '🚨';
    const text = `${icon} *Data quality ${r.status}*: \`${r.label}\`\n${r.detail}`;
    await telegramService.sendMarkdownMessage(text);
    await markAlerted(r.id, startOfToday.getTime());
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

  const dqResults = await runDataQualityChecks(now);
  const dqIcon = (status: string) => status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : status === 'fail' ? '❌' : '⛔';
  const dqLines = dqResults
    .sort((a, b) => Number(b.critical) - Number(a.critical))
    .map(r => `${dqIcon(r.status)} ${r.label}${r.status === 'pass' ? '' : ` — ${r.detail}`}`)
    .join('\n');

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
    '',
    '*Data quality:*',
    dqLines,
  ].join('\n');
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
