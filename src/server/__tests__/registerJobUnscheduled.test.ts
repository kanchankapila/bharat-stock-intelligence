import { beforeEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({
  getRepeatableJobs: vi.fn(), removeRepeatableByKey: vi.fn(), drain: vi.fn(), add: vi.fn(), getJobs: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class { name = 'company-profiles-sync'; constructor() { Object.assign(this, q); } },
  Worker: class { on = vi.fn(); },
}));
vi.mock('../dbAsync', () => ({ dbGet: vi.fn(), dbAll: vi.fn(async () => []), dbRun: vi.fn() }));
vi.mock('../telegramService', () => ({ telegramService: { sendMarkdownMessage: vi.fn() } }));

import { registerRepeatableJob } from '../jobs/registerJob';

// AF-20261017-08 (user decision 2026-10-29): company-profiles-sync failed every night because
// GEMINI_API_KEY is unset. A job can be left unscheduled with a stated reason: its stored
// repeatable is cleared and not re-added, while its worker still runs a manual enqueue.
const cfg = (extra: Record<string, unknown> = {}) => ({
  queueName: 'company-profiles-sync', jobName: 'sync-company-profiles', connection: {} as any,
  repeat: { pattern: '30 15 * * *' }, jobId: 'company-profiles-sync-daily',
  processor: vi.fn(), monitorName: 'company-profiles-sync', ...extra,
}) as any;

describe('registerRepeatableJob unscheduledReason', () => {
  beforeEach(() => {
    delete process.env.SCHEDULER_PAUSED;
    for (const f of Object.values(q)) f.mockReset();
    q.getRepeatableJobs.mockResolvedValue([{ key: 'stale-key', id: 'company-profiles-sync-daily', name: 'sync-company-profiles', next: Date.now() + 1e6 }]);
    q.getJobs.mockResolvedValue([]);
  });

  it('clears the stored schedule and does not re-add it', async () => {
    const out = await registerRepeatableJob(cfg({ unscheduledReason: 'GEMINI_API_KEY not set' }));
    expect(q.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
    expect(q.add).not.toHaveBeenCalled();
    expect(out.worker).toBeDefined();
  });

  it('still schedules normally without a reason', async () => {
    await registerRepeatableJob(cfg());
    expect(q.add).toHaveBeenCalled();
  });
});
