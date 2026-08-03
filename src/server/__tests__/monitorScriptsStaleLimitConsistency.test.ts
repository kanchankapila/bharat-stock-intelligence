import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { MONITOR_SCRIPTS } from '../monitorScripts';

/**
 * Extends the mirror-consistency audit (monitorScriptsCronMirror.test.ts,
 * jobRegistryCronMirror.test.ts) to MONITOR_SCRIPTS.staleLimitHours.
 *
 * staleLimitHours is monitor.router.ts's getSystemStatus() FALLBACK lateness check --
 * `isLate = ageHours > s.staleLimitHours` -- used ONLY for an entry that has no cronPatterns
 * (an entry WITH cronPatterns is judged by computeCronLateness() instead, which is already
 * covered by monitorScriptsCronMirror.test.ts; staleLimitHours sits unused on those entries).
 * For a no-cronPatterns entry, staleLimitHours must be >= the real worst-case gap between
 * consecutive runs of the job that actually drives it, or the entry false-flags 'stale' every
 * time that gap is checked mid-cycle -- exactly the bug class found and fixed 2026-08-03 for
 * technical-scan/regime-detector/performance-tracker (all since given cronPatterns instead,
 * removing them from this file's scope) and financial-ratios/working-capital (staleLimitHours
 * bumped 800->900h after computing the true "first Sunday of month" worst-case gap by hand).
 *
 * This test automates that hand computation so it can't silently go stale again: for each
 * cronPatterns-less entry, it locates the entry's real driving job in source via the same
 * marker-matching technique as jobRegistryCronMirror.test.ts, derives the job's real
 * worst-case gap -- from cron-parser for a literal cron cadence, or from an explicit
 * first-Sunday-of-month model for the one entry (working-capital) whose real cadence is a
 * conditional sub-cadence of a weekly cron, not expressible as a raw cron pattern -- and
 * asserts staleLimitHours clears it with margin.
 *
 * Building this test found a live drift of exactly this kind: financial-ratios still carried
 * its pre-2026-07-31 "First Sunday of month" schedule/900h threshold after
 * financial_ratios_fetcher.py was moved to run unconditionally every Sunday -- not a
 * false-alarm risk (900h > the real 168h worst case), but a genuine staleness-detection blind
 * spot, fixed alongside this test (see monitorScripts.ts's financial-ratios entry).
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

const patRe = /repeat:\s*\{\s*pattern:\s*'([^']+)'/g;
const allPatternMatches = [...src.matchAll(patRe)].map(m => ({ index: m.index!, pattern: m[1] }));

/**
 * Same "check every occurrence of the marker, look only forward, take the globally nearest
 * (occurrence, pattern) pairing" strategy as jobRegistryCronMirror.test.ts's realNear() --
 * see that file for the two real false positives (a bidirectional window latching onto a
 * PRECEDING job's pattern; a marker string that also matches an unrelated `export const
 * QUEUE_X` declaration or later callback reference) that forced this specific approach.
 */
const MAX_LOOKAHEAD = 2000;
function findRealPattern(marker: string): string | null {
  const positions: number[] = [];
  for (let idx = src.indexOf(marker); idx !== -1; idx = src.indexOf(marker, idx + 1)) {
    positions.push(idx);
  }
  if (!positions.length) return null;

  let best: { distance: number; pattern: string } | null = null;
  for (const pos of positions) {
    for (const pm of allPatternMatches) {
      const d = pm.index - pos;
      if (d >= 0 && d <= MAX_LOOKAHEAD && (!best || d < best.distance)) {
        best = { distance: d, pattern: pm.pattern };
      }
    }
  }
  return best?.pattern ?? null;
}

/**
 * Worst-case gap (hours) between consecutive fires of a literal cron pattern, found by
 * cron-parser over a long sample window rather than hand-derived -- for the simple weekly/
 * daily patterns here the gap is constant (cron has no DST/leap-year skew under 'Etc/UTC'),
 * but computing it via the same library the production lateness check uses (jobHeartbeat.ts /
 * monitor.router.ts both import CronExpressionParser) keeps this test honest to the real
 * semantics rather than assuming a fixed-interval shortcut.
 */
function worstCaseGapHoursFromCron(pattern: string, sampleCount = 400): number {
  const interval = CronExpressionParser.parse(pattern, { currentDate: new Date('2024-01-01T00:00:00Z'), tz: 'Etc/UTC' });
  let prev = interval.next().toDate().getTime();
  let worstMs = 0;
  for (let i = 0; i < sampleCount; i++) {
    const next = interval.next().toDate().getTime();
    worstMs = Math.max(worstMs, next - prev);
    prev = next;
  }
  return worstMs / 3_600_000;
}

/**
 * Worst-case gap (hours) between consecutive "first Sunday of month" occurrences -- the real
 * cadence of working_capital_fetcher.py, mf_stock_holdings_fetcher.py, and (pre-2026-07-31)
 * financial_ratios_fetcher.py: all gated by `new Date().getUTCDate() <= 7` inside a job that
 * otherwise fires every Sunday (trendlyneWeekly.jobs.ts's processTrendlyneRatiosMonthly), which
 * is not expressible as a single 5-field cron pattern. Recomputed here by exhaustive calendar
 * search (mirroring the exact method first used by hand on 2026-08-03 to find the 35-day/840h
 * worst case) rather than hand-copying that number, so a calendar-definition slip can't recur.
 */
function worstCaseFirstSundayOfMonthGapHours(): number {
  function firstSunday(year: number, monthIndex: number): number {
    const d = new Date(Date.UTC(year, monthIndex, 1));
    const dow = d.getUTCDay(); // 0 = Sunday
    const daysAhead = (7 - dow) % 7;
    return Date.UTC(year, monthIndex, 1 + daysAhead);
  }
  let worstMs = 0;
  for (let year = 2020; year <= 2035; year++) {
    for (let month = 0; month < 12; month++) {
      const thisFS = firstSunday(year, month);
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      const nextFS = firstSunday(nextYear, nextMonth);
      worstMs = Math.max(worstMs, nextFS - thisFS);
    }
  }
  return worstMs / 3_600_000;
}

/**
 * Worst-case gap (hours) for a job that writes real data 24/7 EXCEPT during weekday NSE market
 * hours (09:15-15:30 IST = 03:45-10:00 UTC, per jobRegistry.ts's own header comment) --
 * confluence-compute's real cadence (added 2026-08-03): its processor returns success without
 * writing whenever isMarketOpen() is true, by design. isMarketOpen() is holiday/weekend-aware
 * (queries live BSE/NSE status), so this window only ever excludes a WEEKDAY session -- unlike
 * the market-hours-ONLY jobs found and fixed elsewhere this session (technical-scan,
 * regime-detector), there is no multi-day weekend gap to model here, since weekends get real
 * writes all day. A fixed 6h15m constant, not a calendar search, since the window itself never
 * varies (no DST in IST, no month-boundary effect the way "first Sunday" has).
 */
function marketHoursSkipWindowHours(): number {
  const marketOpenUtcMinutes = 3 * 60 + 45;  // 03:45 UTC = 09:15 IST
  const marketCloseUtcMinutes = 10 * 60 + 0; // 10:00 UTC = 15:30 IST
  return (marketCloseUtcMinutes - marketOpenUtcMinutes) / 60;
}

describe('MONITOR_SCRIPTS.staleLimitHours consistency', () => {
  it('parser sanity: the weekday market-hours skip window is exactly 6.25h', () => {
    expect(marketHoursSkipWindowHours()).toBe(6.25);
  });

  it('parser sanity: cron-parser worst-case gap for a weekly Sunday pattern is exactly 168h', () => {
    // Pins the helper itself against a known-correct case before trusting it below.
    expect(worstCaseGapHoursFromCron('0 5 * * 0')).toBe(168);
  });

  it('parser sanity: first-Sunday-of-month worst-case gap matches the hand-derived 840h', () => {
    expect(worstCaseFirstSundayOfMonthGapHours()).toBe(840);
  });

  const withoutCron = (MONITOR_SCRIPTS as readonly any[]).filter(s => !s.cronPatterns?.length);

  it('sanity: a meaningful number of entries actually rely on staleLimitHours (no cronPatterns)', () => {
    // Confirms this test has real coverage -- if every entry migrated to cronPatterns, this
    // file would still typecheck and pass with zero assertions run, silently going dead.
    expect(withoutCron.length).toBeGreaterThan(5);
  });

  /**
   * jobName is the source marker used to look up the real driving job's cron pattern; the
   * optional `monthlyGated` flag marks the entry whose real cadence is a conditional
   * sub-cadence of that cron, not the cron itself; `marketHoursSkipGated` marks the entry
   * whose real cadence is "24/7 except weekday market hours" -- no marker/cron lookup needed
   * for that one, since the gap is a fixed constant, not derived from a repeat pattern.
   */
  const driving: Array<{ id: string; jobName?: string; monthlyGated?: boolean; marketHoursSkipGated?: boolean }> = [
    { id: 'ml-ensemble-train', jobName: "'ml-weekly-retrain'" },
    { id: 'strategy-optimizer', jobName: "'ml-weekly-retrain'" },
    { id: 'trendlyne-fundamentals', jobName: "'ml-weekly-retrain'" },
    { id: 'ohlcv-backfill', jobName: "'ohlcv-gap-fill-weekly'" },
    { id: 'dl-trainer', jobName: "jobName: 'dl-retrain-weekly'" },
    { id: 'company-profiles-sync', jobName: "jobName: 'sync-company-profiles'" },
    { id: 'financial-ratios', jobName: "jobName: 'trendlyne-ratios-monthly-check'" },
    { id: 'working-capital', jobName: "jobName: 'trendlyne-ratios-monthly-check'", monthlyGated: true },
    { id: 'tickertape-scorecard', jobName: "jobName: 'tickertape-scorecard-weekly'" },
    { id: 'confluence-compute', marketHoursSkipGated: true },
  ];

  it('driving-job list covers every no-cronPatterns MONITOR_SCRIPTS entry', () => {
    // Fails loud if a new no-cronPatterns entry is added without a corresponding mapping here
    // -- otherwise it would silently skip the staleLimitHours check entirely.
    const covered = new Set(driving.map(d => d.id));
    const missing = withoutCron.map(s => s.id).filter(id => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it.each(driving)('$id: staleLimitHours covers the real worst-case gap for its driving job', ({ id, jobName, monthlyGated, marketHoursSkipGated }) => {
    const entry = (MONITOR_SCRIPTS as readonly any[]).find(s => s.id === id);
    expect(entry, `${id} not found in MONITOR_SCRIPTS`).toBeDefined();
    expect(entry!.staleLimitHours, `${id} has no staleLimitHours`).toBeTypeOf('number');

    if (monthlyGated) {
      const worst = worstCaseFirstSundayOfMonthGapHours();
      expect(
        entry!.staleLimitHours,
        `${id}: staleLimitHours=${entry!.staleLimitHours}h does not cover the real first-Sunday-of-month worst case of ${worst}h`,
      ).toBeGreaterThanOrEqual(worst);
      return;
    }

    if (marketHoursSkipGated) {
      const worst = marketHoursSkipWindowHours();
      expect(
        entry!.staleLimitHours,
        `${id}: staleLimitHours=${entry!.staleLimitHours}h does not cover the real weekday-market-hours-skip worst case of ${worst}h`,
      ).toBeGreaterThanOrEqual(worst);
      return;
    }

    const realPattern = findRealPattern(jobName!);
    expect(realPattern, `no repeat pattern found near marker "${jobName}" for ${id} -- source shape may have changed`).not.toBeNull();
    const worst = worstCaseGapHoursFromCron(realPattern!);
    expect(
      entry!.staleLimitHours,
      `${id}: staleLimitHours=${entry!.staleLimitHours}h does not cover driving job "${jobName}"'s real worst-case gap of ${worst}h (pattern "${realPattern}")`,
    ).toBeGreaterThanOrEqual(worst);
  });

  it('working-capital is not accidentally treated as plain-weekly (it would understate the real gap)', () => {
    // Guards the monthlyGated flag itself: if trendlyne-ratios-monthly-check's cron were ever
    // read as working-capital's real cadence (168h) instead of the true first-Sunday-of-month
    // gap (840h), a staleLimitHours of e.g. 200h would incorrectly pass. Confirms the two
    // worst-case models actually disagree, so the monthlyGated branch above is load-bearing,
    // not a no-op.
    const plainWeekly = worstCaseGapHoursFromCron('30 12 * * 0');
    const monthlyGated = worstCaseFirstSundayOfMonthGapHours();
    expect(monthlyGated).toBeGreaterThan(plainWeekly);
  });
});
