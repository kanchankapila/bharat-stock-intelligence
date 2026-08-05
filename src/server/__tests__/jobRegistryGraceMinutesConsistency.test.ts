import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_REGISTRY } from '../jobRegistry';

/**
 * Extends the mirror-consistency audit (jobRegistryCronMirror.test.ts,
 * monitorScriptsCronMirror.test.ts, monitorScriptsStaleLimitConsistency.test.ts) to
 * JOB_REGISTRY.graceMinutes.
 *
 * jobHeartbeat.ts's getLateJobs(): `deadline = expectedAt + graceMinutes*60000; if (now <
 * deadline) continue;` -- graceMinutes is how long AFTER a cron's expected fire time a job is
 * allowed to still be legitimately running before the heartbeat check flags it 'late' (and, for
 * critical: true entries, sends a real Telegram alert). If graceMinutes is smaller than the
 * job's own declared runtime budget -- its BullMQ Worker `lockDuration`, or an explicit
 * `withJobTimeout(...)` wrapper for jobs whose processor manages its own larger budget -- the
 * job gets flagged 'late' while it is still running completely normally, every single time it
 * takes anywhere close to its own allowed time.
 *
 * This test locates each entry's real driving job in source (same marker-matching technique as
 * jobRegistryCronMirror.test.ts) and asserts graceMinutes covers its declared lockDuration (and,
 * for the two jobs whose processor wraps itself in an explicit `withJobTimeout` budget larger
 * than its Worker's own lockDuration, that budget too).
 *
 * Building this test found real, live drift: mc-screener-sync (grace 60min < lockDuration
 * 90min), and three much larger gaps on the platform's heaviest jobs -- ml-daily-ops (grace
 * 60min vs a Worker lockDuration of 4h / withJobTimeout of 3.5h -- and CLAUDE.md's own job-
 * schedule-review note independently measured this job's real runtime at ~4.4h, so even the
 * 4h lockDuration may be tight), ml-weekly-retrain (grace 180min vs lockDuration 360min), and
 * quant-eod-sync (grace 45min vs lockDuration 120min / withJobTimeout 5.5h, with the source's
 * own comment noting real measured runs of 153/157/239min). All three are large enough, and
 * ml-daily-ops/quant-eod-sync are frequent/heavy enough, that these were very likely producing
 * real false "late" signals on close to every run -- ml-daily-ops is `critical: true`, so this
 * plausibly means a real Telegram "Job running late" alert most weekday evenings for the
 * platform's central ML pipeline. Fixed to the job's own declared ceiling (lockDuration, or
 * MAX(lockDuration, withJobTimeout) where both exist) plus a modest margin, matching this
 * codebase's own convention elsewhere (e.g. financial-ratios' 200h fix, working-capital's 900h) --
 * deliberately NOT stretched all the way to CLAUDE.md's own anecdotal ~4.4h/next-day-completion
 * figures for ml-daily-ops, since those describe an evolving scheduling/pipeline-growth concern
 * already flagged elsewhere as unresolved, not a number this mechanical audit can derive from
 * source. The 17 ml-daily-ops/ml-weekly-retrain StepTracker sub-steps were bumped alongside
 * their parents to preserve the documented "wider than the parent's grace" invariant (checked
 * against the parent's CURRENT JOB_REGISTRY value, not a hardcoded number, so this test stays
 * correct if the parent's grace is ever retuned again without a matching test edit).
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

// Handles both `60 * 1000` and `60_000` numeric-literal styles -- both are used interchangeably
// across this codebase, and missing the underscore form silently drops real matches (found while
// building this test: it made several jobs look like they had no lockDuration at all).
const lockRe = /lockDuration:\s*([0-9*+._\s]+?)(?:,|\s*\/\/|\s*\})/g;
const allLockMatches = [...src.matchAll(lockRe)].map(m => ({
  index: m.index!,
  // eslint-disable-next-line no-new-func -- controlled input: only digits/*+._space, see regex.
  ms: Function(`"use strict"; return (${m[1]});`)() as number,
}));

/**
 * Finds a job's own lockDuration, given a marker string that identifies its registration.
 * Unlike jobRegistryCronMirror.test.ts's realNear() (which checks every occurrence of the
 * marker and searches forward from each, because a job's cron `repeat:` pattern can legitimately
 * sit before OR after different marker occurrences depending on call-site shape), lockDuration
 * is always set on the Worker, constructed textually AFTER the job's own registration in every
 * call site in this codebase -- so searching forward from every occurrence risks the exact
 * failure this test's own construction hit: closed-day-early-batch's `recordHeartbeat(...)` call
 * (a later, unrelated reference to the same string) sat close enough to the NEXT queue's
 * (dl-retrain-emergency's) lockDuration to incorrectly win the "nearest across all occurrences"
 * search. Using only the FIRST occurrence (the registration site) and searching forward from
 * there avoids that ambiguity, verified against every entry in this file by hand before trusting
 * it here.
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

/** withJobTimeout('<name>', <budgetExpr>, ...) budgets -- only ml-daily-ops and quant-eod-sync
 *  wrap their processor in one; both also declare a separate Worker lockDuration, and the real
 *  ceiling is whichever of the two is larger. */
const wjtRe = /withJobTimeout\(\s*[`']([^`']+)[`']\s*,\s*([0-9*._\s]+?)\s*,/g;
const withJobTimeoutBudgets = new Map<string, number>();
for (const m of [...src.matchAll(wjtRe)]) {
  // eslint-disable-next-line no-new-func
  const ms = Function(`"use strict"; return (${m[2]});`)() as number;
  withJobTimeoutBudgets.set(m[1], ms);
}

describe('JOB_REGISTRY.graceMinutes consistency', () => {
  it('parser sanity: finds a healthy number of real lockDuration values in source', () => {
    expect(allLockMatches.length).toBeGreaterThan(20);
  });

  it('parser sanity: finds both known withJobTimeout budgets', () => {
    expect(withJobTimeoutBudgets.get('ml-daily-ops')).toBe(3.5 * 60 * 60 * 1000);
    expect(withJobTimeoutBudgets.get('quant-eod-sync')).toBe(5.5 * 60 * 60_000);
  });

  const scheduled = JOB_REGISTRY.filter(j => j.cronPattern || j.everyMs);

  // jobName -> marker identifying its registration site, reusing exactly the markers already
  // verified correct in jobRegistryCronMirror.test.ts (see that file for how each was derived).
  const driving: Record<string, string> = {
    'stock-refresh': "'refresh-all-daily'",
    'stock-scoring': "jobName: 'score-all'",
    'mc-screener-sync': "jobName: 'mc-sync'",
    'etnow-screener-sync': "jobName: 'etnow-sync'",
    'et-marketstats-sync': "jobName: 'et-marketstats-sync'",
    'trendlyne-screener-sync': "jobName: 'trendlyne-screener-sync'",
    'nse-sync': "jobName: 'nse-sync-weekly'",
    'fundamentals-sync': "jobName: 'sync-fundamentals-weekly'",
    'quant-scoring': "jobName: 'quant-score-daily'",
    'signal-outcomes': "'signal-outcomes-daily'",
    'trendlyne-intraday': "'trendlyne-intraday-scan'",
    // These 6 use the Worker-constructor variable name, not the positional job-name marker
    // used elsewhere: their lockDuration sits far enough past the registration (long comment
    // blocks / a separately-constructed Worker) that it fell outside MAX_LOOKAHEAD from the
    // positional marker -- found while building this test, verified each is a unique string.
    'intraday-fetcher': 'intradayFetcherWorker = new Worker',
    // news-sentiment moved into this group 2026-08-04 -- adding the GNews (3 cycles) + MC
    // stock-news jobs between the 'news-sentiment-refresh' marker and the Worker's
    // lockDuration pushed the distance to 5378 chars, over MAX_LOOKAHEAD (4000).
    'news-sentiment': 'newsSentimentWorker = new Worker',
    'research-premarket': "jobName: 'research-premarket-daily'",
    'research-postclose': "jobName: 'research-postclose-daily'",
    'dl-macro-fetch': "jobName: 'dl-macro-daily'",
    'preopen-snapshot': "'preopen-daily'",
    'market-regime-refresh': "'regime-intraday'",
    'intraday-ranker': "'regime-intraday'",
    'closed-day-early-batch': "'closed-day-early-batch'",
    'confluence-compute': "jobName: 'confluence-compute'",
    'confluence-outcomes': "jobName: 'confluence-outcomes-daily'",
    'agent-data-scientist': "jobName: 'agent-ds-daily'",
    'agent-strategist': "jobName: 'agent-strat-daily'",
    'agent-auditor': "jobName: 'agent-audit-daily'",
    'agent-optimizer': "jobName: 'agent-optim-daily'",
    // Unlike most jobs here, unified-ranker's Worker (and its lockDuration) is constructed
    // BEFORE the 'unified-ranker-daily' addJobWithCatchup call, not after -- forward-search from
    // that marker was landing on the NEXT unrelated job's lockDuration instead (a coincidental,
    // borderline match that broke the moment an unrelated concurrent edit added ~230 chars
    // between them). Same class of fix as intraday-fetcher/news-sentiment above.
    'unified-ranker': 'unifiedRankerWorkerInstance = new Worker',
    'live-screener-collect': 'liveScreenerCollectWorker = new Worker',
    'quant-eod-sync': "'sync-quant-eod'",
    'outcome-resolver': "jobName: 'outcome-resolver-daily'",
    'ml-daily-ops': 'mlDailyOpsWorker = new Worker',
    'trendlyne-daily-fetch': 'trendlyneDailyFetchWorker = new Worker',
    'ml-weekly-retrain': 'mlWeeklyRetrainWorker = new Worker',
    'trendlyne-ratios-monthly': "jobName: 'trendlyne-ratios-monthly-check'",
    'dl-feature-refresh': "jobName: 'dl-feature-daily'",
    'job-digest': "jobName: 'job-digest-daily'",
    'recommendations-digest': "jobName: 'recommendations-digest-daily'",
    'data-quality-daily': "'data-quality-daily-run'",
  };

  // ml-daily-ops/ml-weekly-retrain StepTracker sub-steps have no lockDuration of their own --
  // checked separately below against their parent's graceMinutes, not against a lockDuration.
  const mlDailyOpsSubsteps = [
    'fii-dii-fetcher', 'fii-dii-history', 'tickertape-deals', 'finbert-scorer',
    'outcome-resolver-5d', 'outcome-resolver-15d', 'performance-tracker',
    'densify-feature-matrix', 'nse-bhavcopy-fetcher', 'ml-ensemble-incremental',
    'ml-ensemble-score', 'drift-detector', 'reward-engine', 'rl-agent-update',
    'signal-type-stats',
  ];
  const mlWeeklyRetrainSubsteps = ['ml-ensemble-train', 'strategy-optimizer'];
  const eventDrivenIds = ['ai-signals', 'dl-retrain-emergency'];

  it('driving-job list covers every scheduled JOB_REGISTRY entry not already special-cased', () => {
    const covered = new Set([
      ...Object.keys(driving), ...mlDailyOpsSubsteps, ...mlWeeklyRetrainSubsteps, ...eventDrivenIds,
    ]);
    const missing = scheduled.map(j => j.jobName).filter(n => !covered.has(n));
    expect(missing).toEqual([]);
  });

  it.each(Object.entries(driving))('%s: graceMinutes covers its declared lockDuration (and withJobTimeout, if larger)', (jobName, marker) => {
    const entry = JOB_REGISTRY.find(j => j.jobName === jobName);
    expect(entry, `${jobName} not found in JOB_REGISTRY`).toBeDefined();

    const lockMs = findLockDuration(marker);
    expect(lockMs, `no lockDuration found near marker "${marker}" for ${jobName} -- source shape may have changed`).not.toBeNull();

    const wjtMs = withJobTimeoutBudgets.get(jobName) ?? 0;
    const realMs = Math.max(lockMs!, wjtMs);
    const realMin = realMs / 60_000;

    expect(
      entry!.graceMinutes,
      `${jobName}: graceMinutes=${entry!.graceMinutes}min does not cover its real budget of ${realMin}min ` +
        `(lockDuration=${(lockMs! / 60_000).toFixed(1)}min${wjtMs ? `, withJobTimeout=${(wjtMs / 60_000).toFixed(1)}min` : ''})`,
    ).toBeGreaterThanOrEqual(realMin);
  });

  it.each(mlDailyOpsSubsteps)('%s (ml-daily-ops sub-step): graceMinutes >= parent ml-daily-ops graceMinutes', (jobName) => {
    const entry = JOB_REGISTRY.find(j => j.jobName === jobName);
    const parent = JOB_REGISTRY.find(j => j.jobName === 'ml-daily-ops');
    expect(entry, `${jobName} not found`).toBeDefined();
    expect(parent, 'ml-daily-ops parent not found').toBeDefined();
    expect(
      entry!.graceMinutes,
      `${jobName}: graceMinutes=${entry!.graceMinutes}min is less than parent ml-daily-ops's graceMinutes=${parent!.graceMinutes}min -- a sub-step near the end of the chain can be delayed by up to the parent's own full runtime`,
    ).toBeGreaterThanOrEqual(parent!.graceMinutes);
  });

  it.each(mlWeeklyRetrainSubsteps)('%s (ml-weekly-retrain sub-step): graceMinutes >= parent ml-weekly-retrain graceMinutes', (jobName) => {
    const entry = JOB_REGISTRY.find(j => j.jobName === jobName);
    const parent = JOB_REGISTRY.find(j => j.jobName === 'ml-weekly-retrain');
    expect(entry, `${jobName} not found`).toBeDefined();
    expect(parent, 'ml-weekly-retrain parent not found').toBeDefined();
    expect(entry!.graceMinutes).toBeGreaterThanOrEqual(parent!.graceMinutes);
  });

  it.each(eventDrivenIds)('%s is event-driven (graceMinutes=0, no schedule to be late against)', (jobName) => {
    const entry = JOB_REGISTRY.find(j => j.jobName === jobName);
    expect(entry?.cronPattern).toBeUndefined();
    expect(entry?.everyMs).toBeUndefined();
  });
});
