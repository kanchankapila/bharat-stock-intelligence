import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_REGISTRY } from '../jobRegistry';

/**
 * Locks in the evening-batch data dependency order corrected on 2026-07-31.
 *
 * The bug these guard against: every consumer of the screener tables was scheduled BEFORE the
 * syncs that populate them. `screener_features_fetcher.py` runs inside ml-daily-ops (7:30 PM
 * IST) and builds `screener_momentum_score` — the largest single engine weight in most
 * REGIME_WEIGHTS regimes — off `screener_appearances`, but mc/etnow/et-marketstats only synced
 * at 11:00-11:35 PM. So that feature, and every score derived from it, was a full day stale
 * every single day, silently and with nothing erroring.
 *
 * These are wall-clock assertions on the UTC cron minute-of-day. They intentionally do NOT
 * model runtime — a job starting earlier can still overrun into the next one. They assert the
 * START order only, which is the thing that was actually wrong.
 */

/** Minute-of-day in UTC for a 5-field cron with fixed hour+minute. */
function startMinuteUtc(jobName: string): number {
  const entry = JOB_REGISTRY.find(j => j.jobName === jobName);
  if (!entry?.cronPattern) throw new Error(`${jobName} has no cronPattern in JOB_REGISTRY`);
  const [min, hr] = entry.cronPattern.split(' ');
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hr)) {
    throw new Error(`${jobName} cron "${entry.cronPattern}" is not a fixed hh:mm`);
  }
  return Number(hr) * 60 + Number(min);
}

const SCREENER_SYNCS = ['et-marketstats-sync', 'trendlyne-screener-sync', 'mc-screener-sync', 'etnow-screener-sync'];

describe('evening batch pipeline ordering', () => {
  it.each(SCREENER_SYNCS)(
    '%s runs before ml-daily-ops (which builds screener features from what it writes)',
    (sync) => {
      expect(startMinuteUtc(sync)).toBeLessThan(startMinuteUtc('ml-daily-ops'));
    },
  );

  it.each(SCREENER_SYNCS)(
    '%s runs before stock-scoring (scoring_engine.load_data reads all four screener sources)',
    (sync) => {
      expect(startMinuteUtc(sync)).toBeLessThan(startMinuteUtc('stock-scoring'));
    },
  );

  it('all four screener syncs are now load-bearing ahead of stock-scoring, not just belt-and-braces', () => {
    // 2026-08-04 job-timing audit: stock-scoring's scheduled path now calls recalculateScores()
    // directly instead of syncAndScore() (which used to re-sync trendlyne/mc/etnow in-process
    // before scoring — a THIRD same-evening re-fetch of each, on top of the dedicated 6:00-6:40
    // PM syncs and quant-eod-sync's own now-removed re-sync at 10:00 PM). With no in-process
    // re-sync left anywhere in the scheduled chain, every one of the four dedicated syncs'
    // ordering ahead of stock-scoring is load-bearing — none of them is a belt-and-braces
    // safety net anymore.
    for (const sync of SCREENER_SYNCS) {
      expect(startMinuteUtc(sync)).toBeLessThan(startMinuteUtc('stock-scoring'));
    }
  });

  it('dl-feature-refresh runs after the day OHLCV bar is persisted', () => {
    // feature_engineering.py reads stock_ohlcv; stock-refresh writes that day's bar.
    // Running dl-feature first (it used to fire at 3:30 PM IST, the closing bell) built every
    // DL feature set without the current session in it.
    expect(startMinuteUtc('dl-feature-refresh')).toBeGreaterThan(startMinuteUtc('stock-refresh'));
  });

  it('no two scheduled jobs share a start minute on overlapping days', () => {
    // Parsed from source, NOT from JOB_REGISTRY: several real repeatables
    // (ohlcv-gap-fill-daily, dl-inference, screener-performance) are monitored via
    // MONITOR_SCRIPTS instead and have no registry entry, so a registry-only check is blind
    // to them — that is exactly how ohlcv-gap-fill-daily sat on research-postclose's minute.
    //
    // Scans queues.ts PLUS every src/server/jobs/*.jobs.ts file — the queues.ts decomposition
    // (2026-08) started moving job registration (e.g. stock-scoring, mc/etnow/et-marketstats
    // screener syncs) into src/server/jobs/screeners.jobs.ts via registerRepeatableJob(); a
    // queues.ts-only scan would go blind to those exactly the way a JOB_REGISTRY-only scan
    // was already blind to the MONITOR_SCRIPTS-only jobs above. As more jobs migrate, they
    // stay covered as long as they land in src/server/jobs/*.jobs.ts.
    const jobsDir = join(__dirname, '..', 'jobs');
    const sourceFiles = [
      join(__dirname, '..', 'queues.ts'),
      ...readdirSync(jobsDir).filter(f => f.endsWith('.jobs.ts')).map(f => join(jobsDir, f)),
    ];
    const fixed: Array<{ jobName: string; cronPattern: string }> = [];
    const re = /repeat:\s*\{\s*pattern:\s*'([^']+)'/g;
    for (const file of sourceFiles) {
      const src = readFileSync(file, 'utf8');
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const pattern = m[1];
        if (!/^\d+ \d+ /.test(pattern)) continue; // skip */N and range patterns
        const before = src.slice(Math.max(0, m.index - 2400), m.index);
        const ids = [...before.matchAll(/jobId:\s*'([a-z0-9-]{3,45})'/g)].map(x => x[1]);
        fixed.push({ jobName: ids.at(-1) ?? `@${file}:${m.index}`, cronPattern: pattern });
      }
    }
    expect(fixed.length).toBeGreaterThan(10); // parser sanity — fail loud if the regex rots

    const daysOf = (dow: string): Set<number> => {
      if (dow === '*') return new Set([0, 1, 2, 3, 4, 5, 6]);
      const out = new Set<number>();
      for (const part of dow.split(',')) {
        if (part.includes('-')) {
          const [a, b] = part.split('-').map(Number);
          for (let d = a; d <= b; d++) out.add(d);
        } else out.add(Number(part));
      }
      return out;
    };
    const clashes: string[] = [];
    for (let i = 0; i < fixed.length; i++) {
      for (let k = i + 1; k < fixed.length; k++) {
        const a = fixed[i], b = fixed[k];
        const [aMin, aHr, , , aDow] = a.cronPattern.split(' ');
        const [bMin, bHr, , , bDow] = b.cronPattern.split(' ');
        if (aMin !== bMin || aHr !== bHr) continue;
        const da = daysOf(aDow), db = daysOf(bDow);
        if ([...da].some(d => db.has(d))) clashes.push(`${a.jobName} vs ${b.jobName} @ ${a.cronPattern}`);
      }
    }
    // ml-daily-ops sub-steps deliberately share the parent's cron (they are StepTracker rows
    // for one chain, not independently-scheduled jobs), so exclude same-cron sibling groups.
    const parentCrons = new Set(['20 13 * * 1-5', '0 5 * * 0']);
    const real = clashes.filter(c => ![...parentCrons].some(p => c.endsWith(p)));
    expect(real).toEqual([]);
  });
});
