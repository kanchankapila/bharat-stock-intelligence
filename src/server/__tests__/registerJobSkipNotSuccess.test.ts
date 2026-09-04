import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isConfluenceComputeWindow } from '../jobs/confluence.jobs';
import { JOB_REGISTRY } from '../jobRegistry';
import { getLateJobs } from '../jobHeartbeat';
import { dbExec, dbRun } from '../dbAsync';

/**
 * Pins the fix for recurring-bugs.md's "a job whose skip path falls through to the same
 * 'completed/success' handler as a real run will erase that day's failures" class — 6th
 * recurrence, this time on registerJob.ts's SHARED completed handler rather than on one of
 * queues.ts's hand-rolled ones.
 *
 * scripts/check_recurring_bugs.py's check_skip_not_success only fires when the processor and
 * its `.on('completed')` handler live in the SAME file, which is exactly why it never saw this:
 * the processors are in jobs/*.jobs.ts and the handler is in jobs/registerJob.ts. These tests
 * cover the split-file shape it structurally cannot.
 */
describe('registerRepeatableJob: a skip must not be stamped as a success', () => {
  const registerJobSrc = readFileSync(
    resolve(__dirname, '../jobs/registerJob.ts'), 'utf-8',
  );

  // The guard itself. Asserted on source because the handler is an inline closure passed to a
  // real BullMQ Worker, and the unit project has no Redis to construct one against — but this
  // is the one thing that must be true for every job on the helper, so it is worth pinning.
  // Negative control: deleting the `result?.skipped` early-return fails this.
  it('the shared completed handler returns early on a { skipped: true } result', () => {
    const handler = registerJobSrc.slice(
      registerJobSrc.indexOf("worker.on('completed'"),
      registerJobSrc.indexOf("worker.on('failed'"),
    );
    expect(handler).not.toBe('');
    const guardIdx = handler.search(/\bskipped\b[\s\S]*?\breturn\b/);
    const stampIdx = handler.indexOf('monitor(');
    expect(guardIdx).toBeGreaterThanOrEqual(0);           // guard exists
    expect(guardIdx).toBeLessThan(stampIdx);              // and precedes the heartbeat stamp
  });

  // Sibling fix (ml-promotion-gate-review, 2026-08-19), same shape: a processor that tracks its
  // own steps via StepTracker and returns { success: false, failedSteps } must not have that
  // overwritten by a blanket 'success' either -- the ACTION_ITEMS #16 bug this repo already fixed
  // for ml-daily-ops/ml-weekly-retrain by hand-rolling their own worker outside this helper,
  // generalized so a future job wired through registerRepeatableJob gets it for free.
  // Negative control: deleting the `r?.success === false` branch fails this.
  it('the shared completed handler stamps failed (not success) when the processor reports success:false', () => {
    const handler = registerJobSrc.slice(
      registerJobSrc.indexOf("worker.on('completed'"),
      registerJobSrc.indexOf("worker.on('failed'"),
    );
    const successFalseIdx = handler.search(/success\s*===\s*false/);
    const failedStampIdx = handler.indexOf("monitor(cfg.monitorName, 'failed'");
    // Matches the call regardless of how many more positional args follow 'success' (e.g. the
    // 2026-09-04 durationMs param) -- recurring-bugs.md's marker-distance class warns against
    // exactly this: an exact-closing-paren match breaks the moment the call signature grows.
    const blanketSuccessIdx = handler.lastIndexOf("monitor(cfg.monitorName, 'success'");
    expect(successFalseIdx).toBeGreaterThanOrEqual(0);
    expect(failedStampIdx).toBeGreaterThan(successFalseIdx);
    // The success:false branch must itself return, so it never falls through to the blanket stamp.
    const branchBody = handler.slice(successFalseIdx, handler.indexOf('return;', failedStampIdx));
    expect(branchBody).not.toContain("monitor(cfg.monitorName, 'success'");
    expect(blanketSuccessIdx).toBeGreaterThan(failedStampIdx);
  });

  // The consumer this fix exists for: live_screener_ml_ranker.py --train was a bare .catch,
  // invisible to screener-performance-daily's monitor. Pins that it now reports through
  // StepTracker instead of silently swallowing the failure.
  it('processScreenerPerf tracks live_screener_ml_ranker --train and returns its StepTracker verdict', () => {
    const src = readFileSync(resolve(__dirname, '../jobs/sync.jobs.ts'), 'utf-8');
    const body = src.slice(
      src.indexOf('async function processScreenerPerf'),
      src.indexOf('async function processCompanyProfilesSync'),
    );
    expect(body).toContain("T.run('live-screener-ml-train'");
    expect(body).toContain('T.finish()');
    expect(body).toMatch(/return\s*\{\s*success:\s*verdict\.ok/);
  });

  // confluence-compute is the reason this matters: it no-ops ~9h a day, so without the guard a
  // genuine failure inside its work window was overwritten by the next skip within 30 minutes.
  it('confluence-compute returns the skip marker from BOTH of its no-op paths', () => {
    const src = readFileSync(resolve(__dirname, '../jobs/confluence.jobs.ts'), 'utf-8');
    const body = src.slice(
      src.indexOf('async function processConfluenceCompute'),
      src.indexOf('async function processConfluenceOutcomes'),
    );
    const skipReturns = body.match(/return\s*\{[^}]*skipped:\s*true[^}]*\}/g) ?? [];
    expect(skipReturns).toHaveLength(2);   // market-hours skip + outside-work-window skip
  });

  // The other half of the fix: declining the heartbeat during a long skip window must not make
  // the job look late. This is the phantom-alert class (recurring-bugs.md, 6 recurrences) that
  // the mc-screener-sync / quant-eod-sync graceMinutes bumps were written for.
  it('confluence-compute has late deadlines covering only its real work window', () => {
    const entry = JOB_REGISTRY.find(j => j.jobName === 'confluence-compute')!;
    expect(entry.lateDeadlineCronPatterns).toBeDefined();

    // Every deadline slot must be a UTC time at which the job would actually do work.
    // Negative control: dropping lateDeadlineCronPatterns, or listing a slot outside the
    // window (e.g. '*/30 3-10 * * *', market hours), fails here.
    for (const pattern of entry.lateDeadlineCronPatterns!) {
      const [minField, hourField] = pattern.split(' ');
      const hours = expandCronField(hourField, 0, 23);
      const mins = expandCronField(minField, 0, 59);
      for (const h of hours) {
        for (const m of mins) {
          const utc = new Date(Date.UTC(2026, 7, 18, h, m));  // a Tuesday
          expect(
            isConfluenceComputeWindow(utc),
            `${pattern} -> ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}Z is outside the compute window`,
          ).toBe(true);
        }
      }
    }
  });

  it('confluence-compute is not reported late mid-skip-window on a fresh last success', async () => {
    // Seed through dbAsync — the same accessor getLateJobs reads from. Writing the fixture with
    // a different engine than the assertion reads is its own documented bug class.
    const lastRealWork = Date.UTC(2026, 7, 18, 18, 0);   // 18:00Z = 23:30 IST, the window's last slot
    await dbExec(`CREATE TABLE IF NOT EXISTS job_heartbeat (
      job_name TEXT PRIMARY KEY, last_status TEXT, last_run_at BIGINT, last_success_at BIGINT,
      last_error TEXT, run_count BIGINT DEFAULT 0, fail_count BIGINT DEFAULT 0,
      last_alert_sent_at BIGINT)`);
    await dbRun(
      `INSERT INTO job_heartbeat (job_name, last_status, last_run_at, last_success_at)
       VALUES (?, 'success', ?, ?)
       ON CONFLICT (job_name) DO UPDATE SET last_success_at = excluded.last_success_at`,
      ['confluence-compute', lastRealWork, lastRealWork],
    );

    // 20:00Z = 01:30 IST — deep inside the overnight skip window, ~2h past the 18:00Z slot and
    // well beyond the 45-min grace. With the raw 30-min everyMs cadence this flagged late every
    // night; the deadline patterns are what make it correct. Negative control: remove
    // lateDeadlineCronPatterns from the registry entry and this fails.
    const late = await getLateJobs(new Date('2026-08-18T20:00:00Z'));
    expect(late.map(l => l.job)).not.toContain('confluence-compute');
  });

  // Found while negative-controlling the test above: the everyMs lateness branch anchored on the
  // CURRENT cadence boundary, so with graceMinutes (45) larger than the cadence (15/30 min) the
  // deadline was always in the future and the branch could never fire. All three everyMs entries
  // were in that state — including news-sentiment, which is critical. Negative control: restore
  // `Math.floor(now / everyMs)` in jobHeartbeat.ts and this fails.
  it('an everyMs job that is genuinely stale IS reported late (the branch is not vacuous)', async () => {
    const ancient = Date.UTC(2026, 0, 1);   // 7+ months before the probe time
    await dbExec(`CREATE TABLE IF NOT EXISTS job_heartbeat (
      job_name TEXT PRIMARY KEY, last_status TEXT, last_run_at BIGINT, last_success_at BIGINT,
      last_error TEXT, run_count BIGINT DEFAULT 0, fail_count BIGINT DEFAULT 0,
      last_alert_sent_at BIGINT)`);
    await dbRun(
      `INSERT INTO job_heartbeat (job_name, last_status, last_run_at, last_success_at)
       VALUES (?, 'success', ?, ?)
       ON CONFLICT (job_name) DO UPDATE SET last_success_at = excluded.last_success_at`,
      ['news-sentiment', ancient, ancient],
    );
    // 12:00Z on a Tuesday: news-sentiment is a genuine 24/7 job with no skip window, so there is
    // no hour at which 7 months of silence is acceptable.
    const late = await getLateJobs(new Date('2026-08-18T12:00:00Z'));
    expect(late.map(l => l.job)).toContain('news-sentiment');
  });
});

function expandCronField(field: string, lo: number, hi: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let from = lo, to = hi;
    if (range !== '*') {
      const [a, b] = range.split('-');
      from = Number(a);
      to = b === undefined ? Number(a) : Number(b);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out];
}
