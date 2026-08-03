import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MONITOR_SCRIPTS } from '../monitorScripts';

/**
 * Extends the mirror-consistency audit (monitorScriptsCronMirror.test.ts,
 * monitorScriptsStaleLimitConsistency.test.ts, jobRegistryCronMirror.test.ts,
 * jobRegistryGraceMinutesConsistency.test.ts) to MONITOR_SCRIPTS.graceMinutes.
 *
 * monitor.router.ts's getSystemStatus() calls computeCronLateness(cronPatterns,
 * (s as any).graceMinutes ?? 60, lastRunTime, now) for any entry that has cronPatterns --
 * the exact same "wait graceMinutes past the expected fire time before flagging late"
 * mechanism JOB_REGISTRY.graceMinutes uses, just for the MONITOR_SCRIPTS registry (DB-freshness
 * checks) instead of job_heartbeat. If graceMinutes is smaller than the real driving job's own
 * declared runtime (BullMQ lockDuration, or a larger withJobTimeout budget), the entry gets
 * flagged 'stale' while the underlying script is still running completely normally.
 *
 * This test locates each cronPatterns-bearing entry's real driving job(s) in source (same
 * marker-matching technique as jobRegistryGraceMinutesConsistency.test.ts) and asserts
 * graceMinutes covers the LARGEST of them -- some entries (outcome-resolver-5d/-15d) are fed by
 * two independent jobs via two cronPatterns, and must cover whichever one actually runs longer.
 *
 * Building this test found a large, systematic drift: 9 of the 16 cronPatterns-bearing entries
 * are steps inside the ml-daily-ops chain (cronPatterns: ['0 14 * * 1-5'], the same pattern
 * jobRegistryGraceMinutesConsistency.test.ts already found needed 270min of real headroom, not
 * 60) -- but every one of these 9 MONITOR_SCRIPTS entries was ALSO still set to graceMinutes: 60,
 * completely independently of the JOB_REGISTRY fix (these are two separate registries tracking
 * the same underlying jobs through different mechanisms -- job_heartbeat vs DB-freshness -- so
 * fixing one never touched the other). Four of the nine are `critical: true`
 * (outcome-resolver-5d, performance-tracker, fii-dii-fetcher, ml-ensemble-score), meaning this
 * was very likely producing real "Critical engine stale" Telegram alerts on top of the
 * already-fixed JOB_REGISTRY "Job running late" ones for the exact same underlying chain.
 */

function readAllSource(): string {
  const jobsDir = join(__dirname, '..', 'jobs');
  const files = [
    join(__dirname, '..', 'queues.ts'),
    ...readdirSync(jobsDir).filter(f => f.endsWith('.jobs.ts')).map(f => join(jobsDir, f)),
  ];
  return files.map(f => readFileSync(f, 'utf8')).join('\n');
}

const src = readAllSource();

// Handles both `60 * 1000` and `60_000` numeric-literal styles -- see
// jobRegistryGraceMinutesConsistency.test.ts for why this is necessary (missing the underscore
// form silently dropped several real matches when this was first built).
const lockRe = /lockDuration:\s*([0-9*+._\s]+?)(?:,|\s*\/\/|\s*\})/g;
const allLockMatches = [...src.matchAll(lockRe)].map(m => ({
  index: m.index!,
  // eslint-disable-next-line no-new-func -- controlled input: only digits/*+._space, see regex.
  ms: Function(`"use strict"; return (${m[1]});`)() as number,
}));

/**
 * Finds a job's own lockDuration from the FIRST (registration-site) occurrence of its marker,
 * searching forward only -- see jobRegistryGraceMinutesConsistency.test.ts's findLockDuration()
 * for why "every occurrence, nearest either direction" is unsafe here (it picked up an
 * unrelated LATER job's lockDuration for closed-day-early-batch via a recordHeartbeat(...) call
 * reusing its name).
 */
const MAX_LOOKAHEAD = 4000;
function findLockDuration(marker: string): number | null {
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
  let best: { distance: number; ms: number } | null = null;
  for (const m of allLockMatches) {
    const d = m.index - idx;
    if (d >= 0 && d <= MAX_LOOKAHEAD && (!best || d < best.distance)) best = { distance: d, ms: m.ms };
  }
  return best?.ms ?? null;
}

/** withJobTimeout('<name>', <budgetExpr>, ...) budgets -- only ml-daily-ops wraps its processor
 *  in one among the jobs that drive any MONITOR_SCRIPTS entry here. */
const wjtRe = /withJobTimeout\(\s*[`']([^`']+)[`']\s*,\s*([0-9*._\s]+?)\s*,/g;
const withJobTimeoutBudgets = new Map<string, number>();
for (const m of [...src.matchAll(wjtRe)]) {
  // eslint-disable-next-line no-new-func
  const ms = Function(`"use strict"; return (${m[2]});`)() as number;
  withJobTimeoutBudgets.set(m[1], ms);
}

/** Real ceiling (ms) for a named driving job: MAX(lockDuration, withJobTimeout) where both exist. */
function realCeilingMs(jobKey: string, marker: string): number | null {
  const lockMs = findLockDuration(marker);
  if (lockMs === null) return null;
  const wjtMs = withJobTimeoutBudgets.get(jobKey) ?? 0;
  return Math.max(lockMs, wjtMs);
}

describe('MONITOR_SCRIPTS.graceMinutes consistency', () => {
  it('parser sanity: finds a healthy number of real lockDuration values in source', () => {
    expect(allLockMatches.length).toBeGreaterThan(20);
  });

  const withCron = (MONITOR_SCRIPTS as readonly any[]).filter(s => s.cronPatterns?.length);

  it('sanity: a meaningful number of entries actually rely on graceMinutes (have cronPatterns)', () => {
    expect(withCron.length).toBeGreaterThan(10);
  });

  // id -> [{ jobKey (for withJobTimeout lookup), marker }] -- an array because
  // outcome-resolver-5d/-15d are fed by TWO independent jobs (two cronPatterns) and must cover
  // whichever runs longer, not just the first one found.
  const driving: Record<string, Array<{ jobKey: string; marker: string }>> = {
    'technical-scan': [{ jobKey: 'technical-signals', marker: 'technicalSignalsWorker = new Worker' }],
    'outcome-resolver-5d': [
      { jobKey: 'outcome-resolver-daily', marker: "jobName: 'outcome-resolver-daily'" },
      { jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' },
    ],
    'outcome-resolver-15d': [
      { jobKey: 'outcome-resolver-daily', marker: "jobName: 'outcome-resolver-daily'" },
      { jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' },
    ],
    'performance-tracker': [{ jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' }],
    'fii-dii-fetcher': [{ jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' }],
    'finbert-scorer': [{ jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' }],
    'ml-ensemble-score': [{ jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' }],
    'regime-detector': [{ jobKey: 'dl-regime-daily', marker: "jobName: 'dl-regime-daily'" }],
    'feature-engineering': [{ jobKey: 'dl-feature-daily', marker: "jobName: 'dl-feature-daily'" }],
    'reward-engine': [{ jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' }],
    'rl-agent-update': [{ jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' }],
    'dl-engine-infer': [{ jobKey: 'dl-infer-daily', marker: "jobName: 'dl-infer-daily'" }],
    'signal-type-stats': [{ jobKey: 'ml-daily-ops', marker: 'mlDailyOpsWorker = new Worker' }],
    'screener-performance': [{ jobKey: 'screener-performance-daily', marker: "jobName: 'screener-performance-daily'" }],
    'trendlyne-midweek': [{ jobKey: 'trendlyne-midweek-batch', marker: "jobName: 'trendlyne-midweek-batch'" }],
  };

  // Runs off a Node process setInterval, not a BullMQ job -- no lockDuration exists to compare
  // against. Its graceMinutes (25min) is independently derived from its own 15-min capture
  // interval + tolerance, documented inline in monitorScripts.ts; not this test's concern.
  const noLockDurationIds = ['intraday-breadth-capture'];

  it('driving-job list covers every cronPatterns-bearing entry not explicitly exempted', () => {
    const covered = new Set([...Object.keys(driving), ...noLockDurationIds]);
    const missing = withCron.map(s => s.id).filter(id => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it.each(Object.entries(driving))('%s: graceMinutes covers the largest real ceiling among its driving job(s)', (id, jobs) => {
    const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === id);
    expect(entry, `${id} not found in MONITOR_SCRIPTS`).toBeDefined();

    let worstMs = 0;
    const details: string[] = [];
    for (const { jobKey, marker } of jobs) {
      const ceilingMs = realCeilingMs(jobKey, marker);
      expect(ceilingMs, `no lockDuration found near marker "${marker}" for ${id}'s driving job "${jobKey}" -- source shape may have changed`).not.toBeNull();
      worstMs = Math.max(worstMs, ceilingMs!);
      details.push(`${jobKey}=${(ceilingMs! / 60_000).toFixed(1)}min`);
    }
    const worstMin = worstMs / 60_000;

    expect(
      entry!.graceMinutes,
      `${id}: graceMinutes=${entry!.graceMinutes}min does not cover the real ceiling of ${worstMin}min (${details.join(', ')})`,
    ).toBeGreaterThanOrEqual(worstMin);
  });

  it.each(noLockDurationIds)('%s is setInterval-driven (no lockDuration to compare against)', (id) => {
    const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === id);
    expect(entry?.pyScript).toBeNull();
    expect(entry?.queueName).toBeNull();
  });
});
