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
  inFlight?: Array<{ name: string }>; // active/waiting/delayed jobs already in the queue
} = {}) {
  const { staleRepeatable = true, inFlight = [] } = opts;
  const add = vi.fn().mockResolvedValue({});
  const removeRepeatableByKey = vi.fn().mockResolvedValue(undefined);
  const getRepeatableJobs = vi.fn().mockResolvedValue(
    staleRepeatable ? [{ id: 'test-job-id', key: 'key-1', next: Date.now() - 60_000 }] : [],
  );
  const getJobs = vi.fn(async (states: string[]) => {
    if (states.includes('completed')) return []; // no finished history -> lastRunTime null
    if (states.includes('active')) return inFlight;
    return [];
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

  it('does NOT queue a second catchup when one is already active/waiting/delayed', async () => {
    const queue = makeQueue({ staleRepeatable: true, inFlight: [{ name: 'test-job' }] });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'test-job-id',
    });
    // Only the normal repeatable registration -- no duplicate catchup.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0][1]).not.toMatchObject({ isCatchup: true });
  });

  it('does not touch catchup logic when the schedule was not missed', async () => {
    const queue = makeQueue({ staleRepeatable: false, inFlight: [] });
    await addJobWithCatchup(queue, 'test-job', {}, {
      repeat: { pattern: '0 0 * * *' },
      jobId: 'test-job-id',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
