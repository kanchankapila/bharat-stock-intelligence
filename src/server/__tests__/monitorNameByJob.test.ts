import { describe, it, expect, beforeEach } from 'vitest';
import { registerMonitorName, resolveMonitorName, __resetMonitorNames } from '../jobs/registerJob';

/**
 * Two schedules sharing one queue must record heartbeats under their OWN names.
 *
 * digests.jobs.ts registers `job-digest-daily` (22:50 IST) and `job-digest-morning` (08:15 IST)
 * on the same queue with the same processor, each passing its own `monitorName` — and its
 * comment states the intent outright: "its OWN monitorName so job_heartbeat tracks each
 * schedule separately (one heartbeat row cannot serve two crons without lateness detection
 * reading the wrong boundary)."
 *
 * The mechanism could not deliver it. registerRepeatableJob builds `new Worker(queueName, ...)`
 * per call, so the queue ends up with TWO workers, and each worker's completed/failed handler
 * closes over ITS OWN cfg.monitorName. BullMQ workers on one queue compete for whatever job
 * appears next, so which name a run is recorded under is a race, not a fact about the job.
 *
 * Measured 2026-09-06: `job-digest-morning` had NO job_heartbeat row at all — it read as
 * NEVER RUN in every status view — while `job-digest` showed 1ok/2fail, absorbing both
 * schedules. A never-run job is more dangerous than a failing one: it looks clean in every
 * "show me the failures" view precisely because it has never produced one.
 *
 * The heartbeat name has to come from the JOB, not the worker that happened to win the race.
 */
describe('resolveMonitorName', () => {
  beforeEach(() => __resetMonitorNames());

  it('records a run under the name registered for that job', () => {
    registerMonitorName('job-digest-daily', 'job-digest');
    registerMonitorName('job-digest-morning', 'job-digest-morning');
    expect(resolveMonitorName('job-digest-morning', 'job-digest')).toBe('job-digest-morning');
    expect(resolveMonitorName('job-digest-daily', 'job-digest-morning')).toBe('job-digest');
  });

  it('is independent of which worker picks the job up', () => {
    // The whole point: the same job name resolves identically no matter which worker's
    // fallback is supplied.
    registerMonitorName('job-digest-morning', 'job-digest-morning');
    const viaOwnWorker = resolveMonitorName('job-digest-morning', 'job-digest-morning');
    const viaSiblingWorker = resolveMonitorName('job-digest-morning', 'job-digest');
    expect(viaOwnWorker).toBe(viaSiblingWorker);
  });

  it('falls back to the worker name for a job that never registered one', () => {
    // Catch-up jobs and ad-hoc enqueues carry names nothing registered; those must still
    // record something rather than throw or write undefined.
    expect(resolveMonitorName('some-adhoc-job', 'owning-monitor')).toBe('owning-monitor');
  });

  it('falls back when the job name is missing entirely', () => {
    expect(resolveMonitorName(undefined, 'owning-monitor')).toBe('owning-monitor');
  });

  it('last registration wins, so a re-register on restart does not duplicate', () => {
    registerMonitorName('j', 'first');
    registerMonitorName('j', 'second');
    expect(resolveMonitorName('j', 'fallback')).toBe('second');
  });
});
