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
