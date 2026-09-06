import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addJobWithCatchup } from '../jobs/registerJob';

/**
 * addJobWithCatchup must reclaim orphaned active jobs on its OWN queue, not just queues
 * registered through registerRepeatableJob.
 *
 * Found 2026-09-06: ml-daily-ops (and every other queue built via the older `new Queue()` /
 * `new Worker()` pattern directly in queues.ts, rather than through registerRepeatableJob) sat
 * `active` for 118+ minutes with the SAME job id across a pm2 restart that had just deployed the
 * reclaim fix -- because that fix lived inside registerRepeatableJob, which ml-daily-ops never
 * calls. addJobWithCatchup is the one function EVERY scheduled job in this codebase calls (36
 * call sites, no bypasses), so it -- not registerRepeatableJob -- is where a reclaim that must
 * cover every queue belongs.
 *
 * Drives the REAL reclaimStaleActiveJobs through a fake queue's own getJobs()/moveToFailed(),
 * not a spy on an internal call -- vi.spyOn cannot intercept a same-module function calling
 * another export of that same module (an ESM binding, not a mock-replaceable property), so a
 * spy-based version of this test could never observe the real wiring. Testing the actual
 * moveToFailed side effect is also the more honest test regardless.
 */
function makeOrphanJob(id: string, processedOn: number) {
  return { id, name: 'orphan', processedOn, moveToFailed: vi.fn().mockResolvedValue(undefined) };
}

function fakeQueue(activeJobs: ReturnType<typeof makeOrphanJob>[] = []) {
  return {
    name: 'fake-queue',
    getRepeatableJobs: vi.fn().mockResolvedValue([]),
    removeRepeatableByKey: vi.fn(),
    drain: vi.fn(),
    add: vi.fn(),
    getJobs: vi.fn().mockImplementation((states: string[]) =>
      Promise.resolve(states.includes('active') ? activeJobs : [])),
  } as any;
}

describe('addJobWithCatchup reclaims orphans on its own queue', () => {
  beforeEach(() => { delete process.env.SCHEDULER_PAUSED; });

  it('fails an active job that predates this process, freeing the queue', async () => {
    const orphan = makeOrphanJob('old-job', Date.now() - 60 * 60_000); // started an hour before "now"
    const queue = fakeQueue([orphan]);
    await addJobWithCatchup(queue, 'some-job', {}, {});
    expect(orphan.moveToFailed).toHaveBeenCalledTimes(1);
  });

  it('leaves an active job started by THIS process alone', async () => {
    const current = makeOrphanJob('current-job', Date.now() + 60_000); // processed after "now"
    const queue = fakeQueue([current]);
    await addJobWithCatchup(queue, 'some-job', {}, {});
    expect(current.moveToFailed).not.toHaveBeenCalled();
  });

  it('still reclaims even when the scheduler is paused', async () => {
    // The pause branch returns early; the orphan check must run BEFORE that, since a paused
    // boot is exactly when a prior restart's zombie needs clearing too.
    process.env.SCHEDULER_PAUSED = '1';
    const orphan = makeOrphanJob('paused-orphan', Date.now() - 60 * 60_000);
    const queue = fakeQueue([orphan]);
    await addJobWithCatchup(queue, 'paused-job', {}, {});
    expect(orphan.moveToFailed).toHaveBeenCalledTimes(1);
  });

  it('does not re-scan the same queue object across multiple call sites in one boot', async () => {
    // 36 call sites can share a queue (e.g. multiple jobNames on one queue); re-scanning an
    // already-checked queue on every call is wasted Redis round-trips at boot.
    const orphan = makeOrphanJob('shared-queue-orphan', Date.now() - 60 * 60_000);
    const queue = fakeQueue([orphan]);
    await addJobWithCatchup(queue, 'job-a', {}, {});
    await addJobWithCatchup(queue, 'job-b', {}, {});
    expect(queue.getJobs).toHaveBeenCalledTimes(1);
  });
});
