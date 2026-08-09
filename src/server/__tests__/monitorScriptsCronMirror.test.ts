import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { MONITOR_SCRIPTS } from '../monitorScripts';
import { computeCronLateness } from '../jobHeartbeat';

/**
 * Guards against the class of bug found 2026-08-03 while auditing job/Telegram health:
 * MONITOR_SCRIPTS.cronPatterns mirrors drifting out of sync with the real schedule in
 * queues.ts / src/server/jobs/*.jobs.ts after a job's cron changes there but the mirror is
 * never updated. Six real instances were found and fixed that session:
 *   - feature-engineering / trendlyne-midweek: still carried their PRE-2026-07-31-destagger
 *     cron values after the real jobs (dl-feature-daily, trendlyne-midweek-batch) moved.
 *   - regime-detector / performance-tracker: had NO cronPatterns at all despite being driven
 *     by Mon-Fri-only jobs, so the flat staleLimitHours fallback false-flagged every weekend.
 *   - technical-scan: same gap, with a comment claiming the flat threshold "tolerates the
 *     overnight gap" that never accounted for the real ~64.5h Fri->Mon gap.
 * jobPipelineOrdering.test.ts already source-parses queues.ts + jobs/*.jobs.ts to check
 * JOB_REGISTRY / collision consistency, but never checked MONITOR_SCRIPTS.cronPatterns
 * against that same source -- this file closes that gap using the same parsing approach.
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
 * Finds the repeat pattern registered within `windowChars` of a marker string -- used to pin
 * a MONITOR_SCRIPTS id to the specific job that actually drives its freshness, rather than
 * just "some pattern exists somewhere in source" (which the general sweep below already
 * covers). windowChars defaults generously since a job's `repeat:` line typically sits a
 * handful of lines after its `jobName:`/registration marker, not adjacent to it.
 */
function patternNear(src: string, marker: string, windowChars = 1800): string | null {
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
  const window = src.slice(idx, idx + windowChars);
  const m = /repeat:\s*\{\s*pattern:\s*'([^']+)'/.exec(window);
  return m ? m[1] : null;
}

const src = readAllSource();
const realPatterns = extractRealPatterns(src);

describe('MONITOR_SCRIPTS cronPatterns mirror consistency', () => {
  it('parser sanity: finds a healthy number of real cron patterns in source', () => {
    // Fail loud if the regex rots (e.g. queues.ts/jobs.ts restructured away from this shape)
    // rather than silently passing every test below with an empty haystack.
    expect(realPatterns.size).toBeGreaterThan(15);
  });

  const withCron = (MONITOR_SCRIPTS as readonly any[]).filter(s => s.cronPatterns?.length);

  it('sanity: at least one MONITOR_SCRIPTS entry actually has cronPatterns', () => {
    expect(withCron.length).toBeGreaterThan(5);
  });

  // news-sentiment (added 2026-08-03) is excluded from this literal-string sweep: its
  // cronPatterns ('*/15 * * * *') is a deliberately SYNTHESIZED clock-aligned equivalent of
  // the real job's `repeat: { every: 15*60*1000 }` registration (queues.ts) -- BullMQ's
  // `every:` fires every N ms from an arbitrary phase, not necessarily aligned to :00/:15/:30/
  // :45 the way a cron `*/15 * * * *` is, so this string was never going to appear literally
  // in source and never should. It gets its own equivalence check below instead.
  //
  // intraday-breadth-capture (fixed 2026-08-05) is excluded for the same reason: its 3
  // sub-patterns ('45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5') deliberately narrow the
  // real market-hours window to 3:45-10:00 UTC, tighter than the underlying job's OWN
  // registered '*/15 3-10 * * 1-5' (which is hour-boundary-rounded through 10:45 UTC and
  // caused a real daily false "stale" alert -- see the entry's own comment in
  // monitorScripts.ts). None of the 3 sub-patterns will ever appear verbatim in source.
  it.each(withCron.filter(s => s.id !== 'news-sentiment' && s.id !== 'intraday-breadth-capture').flatMap(s => s.cronPatterns.map((p: string) => ({ id: s.id, pattern: p }))))(
    '$id: cronPattern "$pattern" exists as a real repeat pattern somewhere in source',
    ({ pattern }) => {
      // A pattern that exists nowhere in source is definitely stale -- this alone would have
      // caught feature-engineering (0 10 * * 1-5) and trendlyne-midweek (30 12 * * 2)
      // immediately, since neither string survives anywhere after the 2026-07-31 destagger.
      expect(realPatterns.has(pattern)).toBe(true);
    },
  );

  it("news-sentiment's cronPattern is a genuine 15-min-interval equivalent of the real job's every: 15*60*1000", () => {
    const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === 'news-sentiment');
    expect(entry?.cronPatterns).toEqual(['*/15 * * * *']);

    // Verify the REAL source registration is genuinely a 15-min interval (not some other
    // value the synthesized cron string would then silently misrepresent).
    const everyRe = /'news-sentiment-refresh'[\s\S]{0,400}?repeat:\s*\{\s*every:\s*([0-9*+._\s]+?)(?:,|\s*\})/;
    const m = everyRe.exec(src);
    expect(m, "could not find news-sentiment-refresh's repeat:{every:...} in source -- source shape may have changed").not.toBeNull();
    // eslint-disable-next-line no-new-func
    const realEveryMs = Function(`"use strict"; return (${m![1]});`)() as number;
    expect(realEveryMs).toBe(15 * 60 * 1000);

    // Verify the synthesized cron pattern itself really does fire every 15 minutes, clock-
    // aligned -- not just that the string LOOKS like "15" somewhere in it.
    const interval = CronExpressionParser.parse('*/15 * * * *', { currentDate: new Date('2024-01-01T00:00:00Z'), tz: 'Etc/UTC' });
    let prev = interval.next().toDate().getTime();
    for (let i = 0; i < 20; i++) {
      const next = interval.next().toDate().getTime();
      expect(next - prev).toBe(15 * 60_000);
      prev = next;
    }
  });

  describe("intraday-breadth-capture's synthesized cronPatterns fix (2026-08-05)", () => {
    // Reproduces the exact live false-positive found via the daily Telegram digest: real
    // last capture 2026-08-04T10:00:00.238Z (market close, 15:30 IST), checked at various
    // points through that evening and the next trading day's open.
    const REAL_LAST_SNAPSHOT = new Date('2026-08-04T10:00:00.238Z').getTime();

    it('entry carries the narrowed 3-pattern set, not the coarse hour-rounded job cron', () => {
      const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === 'intraday-breadth-capture');
      expect(entry?.cronPatterns).toEqual(['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5']);
    });

    it('the 3 sub-patterns never expect an occurrence past 10:00 UTC on the capture day', () => {
      const patterns = ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'];
      const cap = new Date('2026-08-04T10:00:00.000Z').getTime();
      // Check every 5 minutes from shortly after close through midnight -- expectedAt must
      // stay pinned at/before 10:00 UTC throughout, never advance to 10:15/10:30/10:45 the
      // way the old coarse '*/15 3-10 * * 1-5' pattern did. Start at +5min: cron-parser's
      // .prev() is exclusive of `now` itself, so checking exactly AT 10:00:00 returns the
      // PRIOR (09:45) occurrence -- not a bug, just means the boundary instant itself needs
      // its own margin, same as any exclusive-prev cron check.
      for (let mins = 5; mins <= 14 * 60; mins += 5) {
        const now = new Date(cap + mins * 60_000);
        const { late, expectedAt } = computeCronLateness(patterns, 25, REAL_LAST_SNAPSHOT, now);
        expect(expectedAt.getTime()).toBeLessThanOrEqual(cap);
        expect(late).toBe(false);
      }
    });

    it('NEGATIVE CONTROL: the old coarse single pattern really does false-flag "stale" for the rest of the evening', () => {
      // Proves the bug was real, not hypothetical -- the exact pattern this entry carried
      // before the 2026-08-05 fix. Checked at 11:15 UTC = 10:45 (last coarse occurrence) +
      // 25min grace + 5min margin, i.e. just past the deadline the real digest alert crossed.
      const oldPattern = ['*/15 3-10 * * 1-5'];
      const checkAt = new Date('2026-08-04T11:15:00Z');
      const { late, expectedAt } = computeCronLateness(oldPattern, 25, REAL_LAST_SNAPSHOT, checkAt);
      expect(expectedAt.toISOString()).toBe('2026-08-04T10:45:00.000Z');
      expect(late).toBe(true); // <-- this is the false "Critical engine stale" alert from the digest
    });

    it('correctly flags genuinely stale (zero captures all day) once that day\'s session has closed', () => {
      // NOTE: during continuous market hours this check structurally can't fire "late" for a
      // 15-min-cadence pattern with a 25min grace (interval < grace means the rolling deadline
      // is always a few minutes in the FUTURE relative to `now`) -- by design, an intraday gap
      // is only ever caught once the day's window has actually closed with nothing landed.
      const patterns = ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'];
      // Last real snapshot is a full trading day earlier than the day being checked -- i.e.
      // 2026-08-04 had ZERO captures at all, checked that same evening (same checkpoint as
      // the false-positive scenario above, but this time genuinely nothing landed that day).
      const staleSince = new Date('2026-08-03T10:00:00.238Z').getTime();
      const checkAt = new Date('2026-08-04T11:15:00Z');
      const { late } = computeCronLateness(patterns, 25, staleSince, checkAt);
      expect(late).toBe(true);
    });
  });

  // Pinned regressions for the five entries fixed 2026-08-03, tied to their specific driving
  // job by name -- stronger than the general sweep above, which only proves the pattern
  // exists SOMEWHERE, not that it's the pattern for the RIGHT job.
  const pinned: Array<{ id: string; marker: string; label: string }> = [
    { id: 'feature-engineering', marker: "jobName: 'dl-feature-daily'", label: 'dl-feature-daily (dl.jobs.ts)' },
    { id: 'trendlyne-midweek', marker: "jobName: 'trendlyne-midweek-batch'", label: 'trendlyne-midweek-batch (trendlyneWeekly.jobs.ts)' },
    { id: 'regime-detector', marker: "jobName: 'dl-regime-daily'", label: 'dl-regime-daily (dl.jobs.ts)' },
    { id: 'dl-engine-infer', marker: "jobName: 'dl-infer-daily'", label: 'dl-infer-daily (dl.jobs.ts)' },
    { id: 'screener-performance', marker: "jobName: 'screener-performance-daily'", label: 'screener-performance-daily (sync.jobs.ts)' },
  ];

  it.each(pinned)('$id matches its driving job: $label', ({ id, marker }) => {
    const real = patternNear(src, marker);
    expect(real, `no repeat pattern found near marker "${marker}" -- source shape may have changed`).not.toBeNull();
    const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === id);
    expect(entry?.cronPatterns, `${id} has no cronPatterns array`).toBeDefined();
    expect(entry!.cronPatterns).toContain(real);
  });

  // technical-scan and performance-tracker are driven by queues declared inline in queues.ts
  // (not yet migrated to the jobs/*.jobs.ts + registerRepeatableJob pattern), so their repeat
  // pattern sits near the Queue() construction rather than a `jobName:` line.
  it('technical-scan matches technicalSignalsQueue (queues.ts)', () => {
    const real = patternNear(src, 'technicalSignalsQueue = new Queue', 2000);
    expect(real).not.toBeNull();
    const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === 'technical-scan');
    expect(entry?.cronPatterns).toContain(real);
  });

  it('performance-tracker matches ml-daily-ops (mlDailyOpsQueue, queues.ts)', () => {
    const real = patternNear(src, 'mlDailyOpsQueue = new Queue', 2000);
    expect(real).not.toBeNull();
    const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === 'performance-tracker');
    expect(entry?.cronPatterns).toContain(real);
  });

  // outcome-resolver-5d/-15d are fed by TWO independent sources (their own dedicated queue
  // plus a step inside ml-daily-ops) -- computeCronLateness() takes the most recent of
  // multiple patterns, so both must be present, not just one.
  it.each(['outcome-resolver-5d', 'outcome-resolver-15d'])(
    '%s carries both its dedicated-queue and ml-daily-ops patterns',
    (id) => {
      const dedicated = patternNear(src, "jobName: 'outcome-resolver-daily'");
      const dailyOps = patternNear(src, 'mlDailyOpsQueue = new Queue', 2000);
      expect(dedicated).not.toBeNull();
      expect(dailyOps).not.toBeNull();
      const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === id);
      expect(entry?.cronPatterns).toContain(dedicated);
      expect(entry?.cronPatterns).toContain(dailyOps);
    },
  );
});
