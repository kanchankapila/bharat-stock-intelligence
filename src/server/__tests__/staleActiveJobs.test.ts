import { describe, it, expect } from 'vitest';
import { isStaleActiveJob } from '../jobs/registerJob';

/**
 * A job left `active` by a killed worker blocks its queue until the lock expires.
 *
 * Hit twice on 2026-09-06 alone. A pm2 restart kills the worker mid-run, but BullMQ keeps the
 * job in `active` until stalled-reclaim fires -- and these queues set lockDuration to 24h
 * because the work legitimately takes hours (dl-retrain-weekly, ml-daily-ops). With
 * concurrency: 1 the queue is then blocked for up to a day, and the duplicate-catch-up guard
 * correctly refuses to queue a replacement because "an instance is already active". So the job
 * silently does not run, and the reason is invisible: `pm2 list` is healthy, getJobCounts shows
 * active: 1, and nothing distinguishes it from a genuinely long run.
 *
 * recurring-bugs.md already records the diagnosis (cross-check a long-active job against the OS
 * process table) but leaves the recovery manual. The one thing a restarting process knows for
 * certain is that any job whose processing began BEFORE this process started cannot belong to
 * it -- no OS lookup, no heuristic about elapsed time.
 *
 * Deliberately keyed on process start rather than an age threshold: a 3-hour-old job is
 * perfectly healthy if this process has been up for 4 hours, and definitely orphaned if it has
 * been up for 30 seconds.
 */
describe('isStaleActiveJob', () => {
  const bootedAt = new Date('2026-09-06T14:00:00Z').getTime();

  it('flags a job whose processing began before this process booted', () => {
    expect(isStaleActiveJob({ processedOn: bootedAt - 60_000 }, bootedAt)).toBe(true);
  });

  it('leaves a job this process started alone, however long it has run', () => {
    // dl-retrain-weekly legitimately runs for hours; elapsed time must not be the signal.
    expect(isStaleActiveJob({ processedOn: bootedAt + 1_000 }, bootedAt)).toBe(false);
  });

  it('does not flag a job that has not started processing', () => {
    // A waiting/delayed job has no processedOn; it is not orphaned, it is queued.
    expect(isStaleActiveJob({ processedOn: null }, bootedAt)).toBe(false);
    expect(isStaleActiveJob({ processedOn: undefined }, bootedAt)).toBe(false);
    expect(isStaleActiveJob({}, bootedAt)).toBe(false);
  });

  it('treats a job started exactly at boot as ours, not orphaned', () => {
    // The boundary must not orphan a job this process just picked up.
    expect(isStaleActiveJob({ processedOn: bootedAt }, bootedAt)).toBe(false);
  });
});
