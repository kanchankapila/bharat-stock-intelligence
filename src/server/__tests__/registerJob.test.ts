import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addJobWithCatchup } from '../jobs/registerJob';

/**
 * Regression coverage for the 2026-08-03 fix: addJobWithCatchup used to decide "missed" by
 * looking only at completed/failed job history, which is blind to a catchup already queued by
 * an earlier restart and still active/waiting/delayed. Two restarts close together (confirmed
 * live for ml-weekly-retrain on 2026-08-02/03) each independently concluded "missed" and queued
 * their own catchup, running two full retrains concurrently and starving exit_policy.py --train
 * of its Python-subprocess slot budget every time.
 */

function makeQueue(opts: {
  staleRepeatable?: boolean;   // getRepeatableJobs() returns an entry whose `next` is in the past
  // active/waiting/delayed jobs already in the queue -- `state` defaults to 'delayed' (the
  // perpetual next-occurrence placeholder's real BullMQ state) so callers only need to set it
  // when a test specifically cares about the 'active' vs 'waiting'/'delayed' distinction.
  inFlight?: Array<{ name: string; data?: any; state?: 'active' | 'waiting' | 'delayed' }>;
  // 2026-08-29 regression: completed/failed job history, queried as two SEPARATE per-status
  // lists (matching the real getJobs(['completed'],...) / getJobs(['failed'],...) call shape),
  // each { finishedOn, timestamp }.
  completedHistory?: Array<{ finishedOn?: number; timestamp: number }>;
  failedHistory?: Array<{ finishedOn?: number; timestamp: number }>;
} = {}) {
  const { staleRepeatable = true, inFlight = [], completedHistory = [], failedHistory = [] } = opts;
  const add = vi.fn().mockResolvedValue({});
  const removeRepeatableByKey = vi.fn().mockResolvedValue(undefined);
  const getRepeatableJobs = vi.fn().mockResolvedValue(
    staleRepeatable ? [{ id: 'test-job-id', key: 'key-1', next: Date.now() - 60_000 }] : [],
  );
  // Filters by each job's real state, the way BullMQ's getJobs actually does -- a job sitting in
  // 'delayed' must NOT show up in a getJobs(['active']) call, or the active-vs-catchup distinction
  // the 2026-08-19 fix relies on can't be exercised. completed/failed are queried as their own
  // single-status calls (the 2026-08-29 fix), each returning its own history array unmodified --
  // real BullMQ already returns newest-first for a single status with asc=false.
  const getJobs = vi.fn(async (states: string[]) => {
    if (states.length === 1 && states[0] === 'completed') return completedHistory;
    if (states.length === 1 && states[0] === 'failed') return failedHistory;
    return inFlight.filter(j => states.includes(j.state ?? 'delayed'));
  });
  return { name: 'test-queue', add, removeRepeatableByKey, getRepeatableJobs, getJobs } as any;
}

describe('addJobWithCatchup', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('queues a catchup when the schedule was missed and nothing is already in flight', async () => {
    const queue = makeQueue({ staleRepeatable: true, inFlight: [] });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'test-job-id',
    });
    // First add() registers the normal repeatable; a second add() is the catchup.
    expect(queue.add).toHaveBeenCalledTimes(2);
    const catchupCall = queue.add.mock.calls[1];
    expect(catchupCall[1]).toMatchObject({ isCatchup: true });
  });

  it('does NOT queue a second catchup when a real catchup is already active/waiting/delayed', async () => {
    const queue = makeQueue({ staleRepeatable: true, inFlight: [{ name: 'test-job', data: { isCatchup: true } }] });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'test-job-id',
    });
    // Only the normal repeatable registration -- no duplicate catchup.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).not.toMatchObject({ isCatchup: true });
  });

  it('regression (2026-08-09): DOES queue a catchup even though the repeatable\'s own normal ' +
     'next occurrence sits in delayed with the same name and no isCatchup flag -- trendlyne-' +
     'ratios-monthly missed its whole Sunday run and 3 restarts each wrongly skipped catch-up ' +
     'against nothing but this placeholder', async () => {
    const queue = makeQueue({ staleRepeatable: true, inFlight: [{ name: 'test-job' /* no data.isCatchup */ }] });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'test-job-id',
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[1][1]).toMatchObject({ isCatchup: true });
  });

  it('does not touch catchup logic when the schedule was not missed', async () => {
    const queue = makeQueue({ staleRepeatable: false, inFlight: [] });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'test-job-id',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('regression (2026-08-19): does NOT queue a duplicate when the LEGITIMATE scheduled run of ' +
     'this job is still active (no isCatchup) -- a restart landing mid-run on a long job like ' +
     'ml-daily-ops used to see no *catchup* pending, conclude "missed", and queue a second full ' +
     'run behind it at concurrency:1', async () => {
    const queue = makeQueue({
      staleRepeatable: true,
      inFlight: [{ name: 'test-job', state: 'active' /* no data.isCatchup -- the real run */ }],
    });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'test-job-id',
    });
    // Only the normal repeatable registration -- no duplicate catchup queued behind the live run.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).not.toMatchObject({ isCatchup: true });
  });

  it('regression (2026-08-29): a recent completed run is not shadowed by an old failed one -- ' +
     'live for ml-weekly-retrain, a combined getJobs([\'completed\',\'failed\'], 0, 1) call ' +
     'returned a month-old failed job as "the last run" on a day the job had actually completed ' +
     'successfully ~11 hours earlier, so every bharat-server restart concluded the weekly ' +
     'schedule was missed and queued a fresh catch-up -- three restarts in one afternoon each ' +
     'queued another one, reproducing the exact concurrent-retrain contention already documented ' +
     'as the cause of exit_policy.py\'s historical timeouts', async () => {
    const now = Date.now();
    const queue = makeQueue({
      staleRepeatable: false,
      inFlight: [],
      // Completed 30 minutes ago -- well within the 24h interval below.
      completedHistory: [{ finishedOn: now - 30 * 60_000, timestamp: now - 60 * 60_000 }],
      // Failed over a month ago -- must NOT win just because 'failed' was queried too.
      failedHistory: [{ finishedOn: now - 40 * 24 * 60 * 60_000, timestamp: now - 40 * 24 * 60 * 60_000 }],
    });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { every: 24 * 60 * 60_000 }, // interval-based, not cron -- deterministic vs. wall clock
      jobId: 'test-job-id',
    });
    // Only the normal repeatable registration -- the recent completion correctly satisfies
    // the schedule, so no catchup should be queued.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).not.toMatchObject({ isCatchup: true });
  });

  it('regression (2026-08-29), inverse: a recent FAILURE (with no completed history at all) ' +
     'still correctly counts as "ran recently" -- the missed-check cares about recency of any ' +
     'run, not success/failure, so it must not ignore failedHistory just because completedHistory ' +
     'is empty', async () => {
    const now = Date.now();
    const queue = makeQueue({
      staleRepeatable: false,
      inFlight: [],
      completedHistory: [], // never completed
      failedHistory: [{ finishedOn: now - 30 * 60_000, timestamp: now - 60 * 60_000 }], // failed 30min ago
    });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { every: 24 * 60 * 60_000 },
      jobId: 'test-job-id',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).not.toMatchObject({ isCatchup: true });
  });

  it('regression (2026-08-29), both stale: when BOTH completed and failed history are older ' +
     'than the schedule interval, a catchup is still correctly queued -- confirms the fix does ' +
     'not accidentally suppress a genuinely-missed run', async () => {
    const now = Date.now();
    const queue = makeQueue({
      staleRepeatable: false,
      inFlight: [],
      completedHistory: [{ finishedOn: now - 40 * 24 * 60 * 60_000, timestamp: now - 40 * 24 * 60 * 60_000 }],
      failedHistory: [{ finishedOn: now - 35 * 24 * 60 * 60_000, timestamp: now - 35 * 24 * 60 * 60_000 }],
    });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { every: 24 * 60 * 60_000 },
      jobId: 'test-job-id',
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[1][1]).toMatchObject({ isCatchup: true });
  });
});
