import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_REGISTRY } from '../jobRegistry';

/**
 * Same audit as monitorScriptsCronMirror.test.ts, applied to JOB_REGISTRY.cronPattern/everyMs.
 *
 * jobPipelineOrdering.test.ts already reads JOB_REGISTRY.cronPattern to check ordering and
 * source-side collisions, but it never checks that a JOB_REGISTRY value itself still matches
 * the real schedule registered in queues.ts / src/server/jobs/*.jobs.ts -- so a JOB_REGISTRY
 * entry could drift the exact same way 6 MONITOR_SCRIPTS entries did (found 2026-08-03) and
 * nothing would catch it: jobHeartbeat.ts's getLateJobs() would compute lateness against a
 * schedule the job no longer runs on, either false-alarming (mirror lags behind a move) or
 * silently tolerating a real outage (mirror is looser than the real cron).
 *
 * Two layers, same as the MONITOR_SCRIPTS version:
 *  1. General sweep: every cronPattern string, and every everyMs numeric value, must exist as
 *     a real `repeat: { pattern: ... }` / `repeat: { every: ... }` registration somewhere in
 *     source. Catches an orphaned stale value outright.
 *  2. Pinned regressions: every non-event-driven JOB_REGISTRY entry tied to its actual driving
 *     job by name/jobId, so drift on any specific entry is caught precisely.
 */

function readAllSource(): string {
  const jobsDir = join(__dirname, '..', 'jobs');
  const files = [
    join(__dirname, '..', 'queues.ts'),
    ...readdirSync(jobsDir).filter(f => f.endsWith('.jobs.ts')).map(f => join(jobsDir, f)),
  ];
  return files.map(f => readFileSync(f, 'utf8')).join('\n');
}

/** Every literal cron pattern string actually registered anywhere in source. */
function extractRealPatterns(src: string): Set<string> {
  const patterns = new Set<string>();
  const re = /repeat:\s*\{\s*pattern:\s*'([^']+)'/g;
  for (let m = re.exec(src); m; m = re.exec(src)) patterns.add(m[1]);
  return patterns;
}

/**
 * Every `every` millisecond interval actually registered anywhere in source. The expressions
 * are simple numeric arithmetic (e.g. `15 * 60 * 1000`), never anything derived from a
 * variable or function call, so evaluating them as plain JS is safe and avoids hand-copying
 * the same arithmetic into this test (which would itself be a second place to drift).
 */
function extractRealEveryValues(src: string): Set<number> {
  const values = new Set<number>();
  const re = /repeat:\s*\{\s*every:\s*([0-9*+\s]+?)(?:,|\s*\})/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // eslint-disable-next-line no-new-func -- controlled input: only digits/*+space, see regex.
    const val = Function(`"use strict"; return (${m[1]});`)();
    if (typeof val === 'number' && Number.isFinite(val)) values.add(val);
  }
  return values;
}

const src = readAllSource();
const realPatterns = extractRealPatterns(src);
const realEveryValues = extractRealEveryValues(src);

describe('JOB_REGISTRY cronPattern/everyMs mirror consistency', () => {
  it('parser sanity: finds a healthy number of real cron patterns in source', () => {
    expect(realPatterns.size).toBeGreaterThan(15);
  });

  it('parser sanity: finds a healthy number of real `every` intervals in source', () => {
    expect(realEveryValues.size).toBeGreaterThan(3);
  });

  const scheduled = JOB_REGISTRY.filter(j => j.cronPattern || j.everyMs);
  const eventDriven = JOB_REGISTRY.filter(j => !j.cronPattern && !j.everyMs);

  it('sanity: most JOB_REGISTRY entries carry a schedule (a few are legitimately event-driven)', () => {
    expect(scheduled.length).toBeGreaterThan(40);
    // ai-signals and dl-retrain-emergency are the only two by design (see jobRegistry.ts).
    expect(eventDriven.length).toBeLessThanOrEqual(4);
  });

  it.each(scheduled.filter(j => j.cronPattern).map(j => ({ jobName: j.jobName, pattern: j.cronPattern! })))(
    '$jobName: cronPattern "$pattern" exists as a real repeat pattern somewhere in source',
    ({ pattern }) => {
      expect(realPatterns.has(pattern)).toBe(true);
    },
  );

  it.each(scheduled.filter(j => j.everyMs).map(j => ({ jobName: j.jobName, everyMs: j.everyMs! })))(
    '$jobName: everyMs $everyMs exists as a real repeat interval somewhere in source',
    ({ everyMs }) => {
      expect(realEveryValues.has(everyMs)).toBe(true);
    },
  );

  const patRe = /repeat:\s*\{\s*pattern:\s*'([^']+)'/g;
  const everyRe = /repeat:\s*\{\s*every:\s*([0-9*+\s]+?)(?:,|\s*\})/g;
  const allPatternMatches = [...src.matchAll(patRe)].map(m => ({ index: m.index!, pattern: m[1] }));
  const allEveryMatches = [...src.matchAll(everyRe)].map(m => ({
    index: m.index!,
    // eslint-disable-next-line no-new-func -- controlled input: only digits/*+space, see regex.
    every: Function(`"use strict"; return (${m[1]});`)() as number,
  })).filter(m => Number.isFinite(m.every));

  /**
   * Finds a job's own repeat pattern/every-value, given a marker string that identifies its
   * registration. A marker's literal text can legitimately appear multiple times in source
   * (a `export const QUEUE_X = 'x';` constant, the registration itself, and later
   * `.on('completed', ...)`/`recordHeartbeat('x', ...)` references all reuse the same job-id
   * string) -- and the marker's own `repeat:` line can sit before OR after it depending on
   * call-site shape. Fixed-offset or bidirectional windows are both unreliable here: a window
   * too narrow misses a long comment block between marker and repeat; a window that searches
   * backward can instead latch onto an unrelated PRECEDING job's repeat if this job's own
   * comment block happens to be longer than the gap to that neighbor (a real failure mode this
   * function was rewritten to fix, found empirically -- see mc-screener-sync/dl-feature-refresh
   * below). Instead: check every occurrence of the marker, look only FORWARD from each (every
   * verified call site in this codebase lists its OWN job-name/jobId before or immediately
   * alongside its `repeat:` -- never significantly after with unrelated content in between),
   * and take whichever (occurrence, repeat) pairing has the smallest forward distance. A job's
   * true registration is always by far the closest forward repeat: to at least one of its own
   * marker occurrences; an unrelated constant declaration (typically thousands of chars before
   * any real registration) or a later callback reference (whose nearest forward repeat:, if
   * any, belongs to some subsequent, unrelated job and is therefore farther) cannot win against
   * that unless MAX_LOOKAHEAD were absurdly large, which it isn't.
   */
  const MAX_LOOKAHEAD = 2000;
  function realNear(marker: string): { pattern: string | null; every: number | null } {
    const positions: number[] = [];
    for (let idx = src.indexOf(marker); idx !== -1; idx = src.indexOf(marker, idx + 1)) {
      positions.push(idx);
    }
    if (!positions.length) return { pattern: null, every: null };

    let best: { distance: number; pattern: string | null; every: number | null } | null = null;
    for (const pos of positions) {
      for (const pm of allPatternMatches) {
        const d = pm.index - pos;
        if (d >= 0 && d <= MAX_LOOKAHEAD && (!best || d < best.distance)) {
          best = { distance: d, pattern: pm.pattern, every: null };
        }
      }
      for (const em of allEveryMatches) {
        const d = em.index - pos;
        if (d >= 0 && d <= MAX_LOOKAHEAD && (!best || d < best.distance)) {
          best = { distance: d, pattern: null, every: em.every };
        }
      }
    }
    return best ? { pattern: best.pattern, every: best.every } : { pattern: null, every: null };
  }

  // ml-daily-ops and ml-weekly-retrain each run ~15/2 StepTracker sub-steps that share their
  // parent queue's cron rather than being independently registered -- so they're pinned to the
  // SAME marker as their parent, deliberately (this is correct, not a shortcut: the sub-steps
  // genuinely have no schedule of their own).
  const mlDailyOpsSubsteps = [
    'fii-dii-fetcher', 'fii-dii-history', 'tickertape-deals', 'finbert-scorer',
    'outcome-resolver-5d', 'outcome-resolver-15d', 'performance-tracker',
    'densify-feature-matrix', 'nse-bhavcopy-fetcher', 'ml-ensemble-incremental',
    'ml-ensemble-score', 'drift-detector', 'reward-engine', 'rl-agent-update',
    'signal-type-stats', 'news-symbol-link',
  ];
  const mlWeeklyRetrainSubsteps = ['ml-ensemble-train', 'strategy-optimizer'];

  const pinned: Array<{ jobName: string; marker: string; label: string }> = [
    // Legacy hand-rolled queues.ts registrations (not yet migrated to registerRepeatableJob).
    // Markers use the POSITIONAL job-name argument (addJobWithCatchup(queue, '<name>', ...) /
    // queue.add('<name>', ...)), verified to precede `repeat:` at every one of these call
    // sites -- unlike jobId, which sits AFTER `repeat:` at several of them.
    { jobName: 'stock-refresh', marker: "'refresh-all-daily'", label: 'stockRefreshQueue' },
    { jobName: 'signal-outcomes', marker: "'signal-outcomes-daily'", label: 'signalOutcomesQueue' },
    { jobName: 'news-sentiment', marker: "'news-sentiment-refresh'", label: 'newsSentimentQueue (15-min cadence)' },
    { jobName: 'trendlyne-intraday', marker: "'trendlyne-intraday-scan'", label: 'trendlyneIntradayQueue' },
    { jobName: 'intraday-fetcher', marker: "'intraday-fetcher'", label: 'intradayFetcherQueue' },
    { jobName: 'gdelt-sentiment', marker: "'gdelt-sentiment'", label: 'gdeltSentimentQueue' },
    { jobName: 'preopen-snapshot', marker: "'preopen-daily'", label: 'preopenQueue' },
    { jobName: 'market-regime-refresh', marker: "'regime-intraday'", label: 'regimeQueue' },
    { jobName: 'intraday-ranker', marker: "'regime-intraday'", label: 'regimeQueue (shared with market-regime-refresh)' },
    { jobName: 'closed-day-early-batch', marker: "'closed-day-early-batch'", label: 'closedDayQueue' },
    { jobName: 'unified-ranker', marker: "'unified-ranker-daily'", label: 'unifiedRankerQueue' },
    { jobName: 'live-screener-collect', marker: "'live-screener-collect'", label: 'liveScreenerCollectQueue' },
    { jobName: 'quant-eod-sync', marker: "'sync-quant-eod'", label: 'quantEodSyncQueue' },
    { jobName: 'trendlyne-daily-fetch', marker: "'trendlyne-daily-fetch'", label: 'trendlyneDailyFetchQueue' },
    { jobName: 'ml-daily-ops', marker: "'ml-daily-ops'", label: 'mlDailyOpsQueue' },
    { jobName: 'ml-weekly-retrain', marker: "'ml-weekly-retrain'", label: 'mlWeeklyRetrainQueue' },
    { jobName: 'data-quality-daily', marker: "'data-quality-daily-run'", label: 'dataQualityDailyQueue' },

    // registerRepeatableJob-based registrations (src/server/jobs/*.jobs.ts).
    { jobName: 'stock-scoring', marker: "jobName: 'score-all'", label: 'screeners.jobs.ts' },
    { jobName: 'mc-screener-sync', marker: "jobName: 'mc-sync'", label: 'screeners.jobs.ts' },
    { jobName: 'etnow-screener-sync', marker: "jobName: 'etnow-sync'", label: 'screeners.jobs.ts' },
    { jobName: 'et-marketstats-sync', marker: "jobName: 'et-marketstats-sync'", label: 'screeners.jobs.ts' },
    { jobName: 'trendlyne-screener-sync', marker: "jobName: 'trendlyne-screener-sync'", label: 'screeners.jobs.ts' },
    { jobName: 'fundamentals-sync', marker: "jobName: 'sync-fundamentals-weekly'", label: 'screeners.jobs.ts' },
    { jobName: 'quant-scoring', marker: "jobName: 'quant-score-daily'", label: 'screeners.jobs.ts' },
    { jobName: 'nse-sync', marker: "jobName: 'nse-sync-weekly'", label: 'sync.jobs.ts' },
    { jobName: 'confluence-compute', marker: "jobName: 'confluence-compute'", label: 'confluence.jobs.ts' },
    { jobName: 'confluence-outcomes', marker: "jobName: 'confluence-outcomes-daily'", label: 'confluence.jobs.ts' },
    { jobName: 'agent-data-scientist', marker: "jobName: 'agent-ds-daily'", label: 'agents.jobs.ts' },
    { jobName: 'agent-strategist', marker: "jobName: 'agent-strat-daily'", label: 'agents.jobs.ts' },
    { jobName: 'agent-auditor', marker: "jobName: 'agent-audit-daily'", label: 'agents.jobs.ts' },
    { jobName: 'agent-optimizer', marker: "jobName: 'agent-optim-daily'", label: 'agents.jobs.ts' },
    { jobName: 'dl-macro-fetch', marker: "jobName: 'dl-macro-daily'", label: 'dl.jobs.ts' },
    { jobName: 'dl-feature-refresh', marker: "jobName: 'dl-feature-daily'", label: 'dl.jobs.ts' },
    { jobName: 'research-premarket', marker: "jobName: 'research-premarket-daily'", label: 'operations.jobs.ts' },
    { jobName: 'research-postclose', marker: "jobName: 'research-postclose-daily'", label: 'operations.jobs.ts' },
    { jobName: 'outcome-resolver', marker: "jobName: 'outcome-resolver-daily'", label: 'operations.jobs.ts' },
    { jobName: 'chatbot-reingest', marker: "jobName: 'chatbot-reingest-daily'", label: 'operations.jobs.ts' },
    { jobName: 'trendlyne-ratios-monthly', marker: "jobName: 'trendlyne-ratios-monthly-check'", label: 'trendlyneWeekly.jobs.ts' },
    { jobName: 'job-digest', marker: "jobName: 'job-digest-daily'", label: 'digests.jobs.ts' },
    { jobName: 'recommendations-digest', marker: "jobName: 'recommendations-digest-daily'", label: 'digests.jobs.ts' },

    // ml-daily-ops / ml-weekly-retrain StepTracker sub-steps -- share the parent's schedule.
    ...mlDailyOpsSubsteps.map(jobName => ({ jobName, marker: "'ml-daily-ops'", label: 'mlDailyOpsQueue (StepTracker sub-step)' })),
    ...mlWeeklyRetrainSubsteps.map(jobName => ({ jobName, marker: "'ml-weekly-retrain'", label: 'mlWeeklyRetrainQueue (StepTracker sub-step)' })),
  ];

  it('pinned list covers every non-event-driven JOB_REGISTRY entry', () => {
    // Fails loud if a new job is added to JOB_REGISTRY without a corresponding pin here --
    // the general sweep above would still catch a totally-orphaned pattern, but a new entry
    // that happens to reuse an existing valid pattern string would sail through silently.
    const pinnedNames = new Set(pinned.map(p => p.jobName));
    const missing = scheduled.map(j => j.jobName).filter(n => !pinnedNames.has(n));
    expect(missing).toEqual([]);
  });

  it.each(pinned)('$jobName matches its driving job: $label', ({ jobName, marker }) => {
    const real = realNear(marker);
    expect(
      real.pattern !== null || real.every !== null,
      `no repeat pattern/every found near marker "${marker}" for ${jobName} -- source shape may have changed`,
    ).toBe(true);

    const entry = JOB_REGISTRY.find(j => j.jobName === jobName);
    expect(entry, `${jobName} not found in JOB_REGISTRY`).toBeDefined();

    if (entry!.cronPattern) {
      expect(real.pattern, `${jobName}: expected a cron pattern near "${marker}", found an every-interval instead`).not.toBeNull();
      expect(entry!.cronPattern).toBe(real.pattern);
    } else if (entry!.everyMs) {
      expect(real.every, `${jobName}: expected an every-interval near "${marker}", found a cron pattern instead`).not.toBeNull();
      expect(entry!.everyMs).toBe(real.every);
    }
  });

  // outcome-resolver-5d/-15d are the two entries fed by a single ml-daily-ops cron in
  // JOB_REGISTRY (unlike the equivalent MONITOR_SCRIPTS entries, which additionally track the
  // dedicated 9:30am outcome-resolver queue via a second cronPatterns element) -- sanity-check
  // that assumption still holds rather than silently trusting it.
  it('outcome-resolver-5d/-15d (JOB_REGISTRY) are single-pattern, tracking only ml-daily-ops', () => {
    const fiveD = JOB_REGISTRY.find(j => j.jobName === 'outcome-resolver-5d');
    const fifteenD = JOB_REGISTRY.find(j => j.jobName === 'outcome-resolver-15d');
    expect(fiveD?.cronPattern).toBe('20 13 * * 1-5');
    expect(fifteenD?.cronPattern).toBe('20 13 * * 1-5');
  });
});
