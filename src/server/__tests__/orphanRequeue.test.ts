import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reclaimStaleActiveJobs,
  requeueOrphanedJob,
  ORPHAN_REQUEUE_MAX_AGE_MS,
  ORPHAN_REQUEUE_SKIP_WINDOW_MS,
} from '../jobs/registerJob';

/**
 * AF-20260909-06: a job orphaned by a pm2 restart mid-run used to be FAILED by
 * reclaimStaleActiveJobs and never re-queued -- and the failed state was self-masking, since
 * the orphan's fresh finishedOn made addJobWithCatchup's missed-slot detector believe the job
 * had "just run". That is how the 2026-09-08 ml-daily-ops batch (block deals, exit labels,
 * performance_tracker, mf_sector_allocation) was silently lost for a full day while every
 * sibling heartbeat stayed green.
 *
 * These tests drive the REAL reclaimStaleActiveJobs + requeueOrphanedJob through a fake queue
 * (same reason as addJobWithCatchupReclaims.test.ts: a spy cannot intercept same-module ESM
 * calls, and asserting the real queue.add side effect is the more honest test).
 *
 * The Telegram alert is fire-and-forget via a dynamic import; vi.mock replaces the module so
 * the tests stay hermetic (no DB settings lookup, no network).
 */
vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: vi.fn().mockResolvedValue(true) },
  sanitizeMarkdown: (t: string) => t,
}));

const HOUR = 60 * 60_000;

function makeOrphanJob(id: string, processedOn: number) {
  return {
    id, name: 'ml-daily-ops', processedOn,
    data: { foo: 'bar' },
    moveToFailed: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeQueue(opts: {
  activeJobs?: ReturnType<typeof makeOrphanJob>[];
  repeatables?: Array<{ name: string; next?: number }>;
  inFlight?: Array<{ name: string; data?: any }>;
} = {}) {
  return {
    name: 'ml-queue',
    getRepeatableJobs: vi.fn().mockResolvedValue(opts.repeatables ?? []),
    removeRepeatableByKey: vi.fn(),
    drain: vi.fn(),
    add: vi.fn().mockResolvedValue(undefined),
    getJobs: vi.fn().mockImplementation((states: string[]) => {
      // reclaimStaleActiveJobs calls with ['active'] only; the guard's in-flight check calls
      // with ['active','waiting','delayed'] -- distinguish them or the orphan itself (still in
      // the active list) shadows the inFlight fixture.
      if (states.length === 1 && states[0] === 'active') {
        return Promise.resolve(opts.activeJobs ?? []);
      }
      return Promise.resolve(opts.inFlight ?? []);
    }),
  } as any;
}

describe('requeueOrphanedJob (AF-20260909-06)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('requeues a make-up run for an orphan whose next scheduled slot is far away', async () => {
    const queue = fakeQueue({
      repeatables: [{ name: 'ml-daily-ops', next: Date.now() + 22 * HOUR }],
    });
    const ok = await requeueOrphanedJob(queue, makeOrphanJob('1', Date.now() - 2 * HOUR));
    expect(ok).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('ml-daily-ops');
    expect(data).toMatchObject({ foo: 'bar', isCatchup: true, orphanRequeue: true, requeuedFrom: '1' });
    expect(opts.attempts).toBe(1);           // no retry cascade on top of a make-up
    expect(opts.delay).toBe(0);              // first stagger slot
    expect(String(opts.jobId)).toContain('orphan-requeue');
  });

  it('does NOT requeue when the regular schedule fires again within the skip window', async () => {
    const queue = fakeQueue({
      repeatables: [{ name: 'ml-daily-ops', next: Date.now() + 10 * 60_000 }],
    });
    const ok = await requeueOrphanedJob(queue, makeOrphanJob('2', Date.now() - HOUR));
    expect(ok).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does NOT suppress the requeue just because a STALE PAST next exists (cron-swap case)', async () => {
    // 2026-09-09: the mover queue's old 16:05 repeatable sat with a past `next` while the new
    // registration was pending -- a past fire covers nothing and must not block the make-up.
    const queue = fakeQueue({
      repeatables: [{ name: 'ml-daily-ops', next: Date.now() - 5 * HOUR }],
    });
    const ok = await requeueOrphanedJob(queue, makeOrphanJob('3', Date.now() - HOUR));
    expect(ok).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does NOT stack a duplicate when a make-up/catch-up is already in flight', async () => {
    const queue = fakeQueue({
      inFlight: [{ name: 'ml-daily-ops', data: { isCatchup: true } }],
    });
    const ok = await requeueOrphanedJob(queue, makeOrphanJob('4', Date.now() - HOUR));
    expect(ok).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('recognizes its own orphanRequeue marker as an in-flight make-up too', async () => {
    const queue = fakeQueue({
      inFlight: [{ name: 'ml-daily-ops', data: { orphanRequeue: true } }],
    });
    const ok = await requeueOrphanedJob(queue, makeOrphanJob('5', Date.now() - HOUR));
    expect(ok).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('ignores unrelated pending jobs (different name or plain scheduled occurrence)', async () => {
    const queue = fakeQueue({
      repeatables: [{ name: 'ml-daily-ops', next: Date.now() + 22 * HOUR }],
      // the repeatable's own next occurrence sits delayed with the same name but no marker
      inFlight: [{ name: 'ml-daily-ops', data: {} }, { name: 'other-job', data: { isCatchup: true } }],
    });
    const ok = await requeueOrphanedJob(queue, makeOrphanJob('6', Date.now() - HOUR));
    expect(ok).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('alerts only (no requeue) when the orphan is past the staleness horizon', async () => {
    const queue = fakeQueue();
    const old = makeOrphanJob('7', Date.now() - ORPHAN_REQUEUE_MAX_AGE_MS - HOUR);
    const ok = await requeueOrphanedJob(queue, old);
    expect(ok).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('treats a missing processedOn as requeueable (no staleness evidence)', async () => {
    const queue = fakeQueue();
    const { processedOn, ...noTs } = makeOrphanJob('8', Date.now());
    const ok = await requeueOrphanedJob(queue, noTs as any);
    expect(ok).toBe(true);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('never throws even when the queue add fails', async () => {
    const queue = fakeQueue();
    queue.add.mockRejectedValue(new Error('redis down'));
    await expect(requeueOrphanedJob(queue, makeOrphanJob('9', Date.now() - HOUR))).resolves.toBe(false);
  });
});

describe('reclaimStaleActiveJobs wires the requeue in (AF-20260909-06)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('a reclaimed orphan gets its make-up requeued by the reclaim itself', async () => {
    const orphan = makeOrphanJob('old', Date.now() - HOUR);
    const queue = fakeQueue({ activeJobs: [orphan] });
    const reclaimed = await reclaimStaleActiveJobs(queue);
    expect(orphan.moveToFailed).toHaveBeenCalledTimes(1);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ name: 'ml-daily-ops', id: 'old', requeued: true });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('an orphan covered by an imminent regular slot is reclaimed but NOT requeued', async () => {
    const orphan = makeOrphanJob('soon', Date.now() - HOUR);
    const queue = fakeQueue({
      activeJobs: [orphan],
      repeatables: [{ name: 'ml-daily-ops', next: Date.now() + ORPHAN_REQUEUE_SKIP_WINDOW_MS / 2 }],
    });
    const reclaimed = await reclaimStaleActiveJobs(queue);
    expect(orphan.moveToFailed).toHaveBeenCalledTimes(1);
    expect(reclaimed[0].requeued).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
