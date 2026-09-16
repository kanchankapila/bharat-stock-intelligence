import { describe, it, expect, afterEach } from 'vitest';
import { schedulerIsPaused, lateJobsToAlert } from '../jobWatchdog';

/**
 * A deliberately-unscheduled job is not late.
 *
 * SCHEDULER_PAUSED=1 takes the whole platform off its schedule (for a validation sweep, a
 * migration, a deploy) by clearing every repeatable and draining every queue. The lateness
 * watchdog knew nothing about it: it wakes every 15 minutes, asks getLateJobs() "what has
 * missed its cron slot", and while paused the honest answer is EVERY job -- so it sent a
 * "Job running late" Telegram for each critical one, every 15 minutes, for the whole pause.
 *
 * Measured live 2026-09-05: this is the direct mechanical cause of the "so many delays and
 * misses" the user was seeing. The jobs were fine; they had been switched off on purpose and
 * the alerting layer was never told.
 *
 * The fix must not simply mute the watchdog, or a pause becomes a blind spot: it reports the
 * pause itself, once, instead of one alert per job.
 */
const ORIGINAL = process.env.SCHEDULER_PAUSED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SCHEDULER_PAUSED;
  else process.env.SCHEDULER_PAUSED = ORIGINAL;
});

const item = (job: string) => ({
  job, label: job, expectedAt: new Date('2026-09-05T10:00:00Z'), hoursLate: 4, lastError: null,
});

describe('schedulerIsPaused', () => {
  it('is true only for the exact value the scheduler itself checks', () => {
    process.env.SCHEDULER_PAUSED = '1';
    expect(schedulerIsPaused()).toBe(true);
  });

  it('is false when unset, empty, or 0 -- matching registerJob.ts exactly', () => {
    // registerJob.ts gates on `=== '1'`. If these two ever disagree, the platform can be
    // half-paused: jobs unscheduled but the watchdog still alerting, or the reverse.
    for (const v of ['0', '', 'false', 'true', 'yes']) {
      process.env.SCHEDULER_PAUSED = v;
      expect(schedulerIsPaused(), `value ${JSON.stringify(v)}`).toBe(false);
    }
    delete process.env.SCHEDULER_PAUSED;
    expect(schedulerIsPaused()).toBe(false);
  });
});

describe('lateJobsToAlert', () => {
  it('suppresses every per-job late alert while the scheduler is paused', () => {
    process.env.SCHEDULER_PAUSED = '1';
    expect(lateJobsToAlert([item('a'), item('b'), item('c')])).toEqual([]);
  });

  it('alerts normally when the scheduler is running', () => {
    delete process.env.SCHEDULER_PAUSED;
    expect(lateJobsToAlert([item('a'), item('b')]).map(i => i.job)).toEqual(['a', 'b']);
  });

  it('passes an empty list through unchanged in both states', () => {
    delete process.env.SCHEDULER_PAUSED;
    expect(lateJobsToAlert([])).toEqual([]);
    process.env.SCHEDULER_PAUSED = '1';
    expect(lateJobsToAlert([])).toEqual([]);
  });
});
