import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ name: string; state: string; message?: string }> = [];
vi.mock('../monitoringService', () => ({
  updateMonitorState: vi.fn((name: string, state: string, message?: string) => {
    calls.push({ name, state, message });
  }),
}));

import { StepTracker } from '../jobSteps';

describe('StepTracker', () => {
  beforeEach(() => { calls.length = 0; });

  it('records success and returns the step value', async () => {
    const T = new StepTracker('job');
    const r = await T.run('step-a', async () => 42);
    expect(r).toBe(42);
    T.finish();
    expect(calls).toContainEqual({ name: 'step-a', state: 'success', message: undefined });
    expect(calls).toContainEqual({ name: 'job', state: 'success', message: undefined });
  });

  it('captures a throwing step, returns undefined, and never rethrows', async () => {
    const T = new StepTracker('job');
    const r = await T.run('step-b', async () => { throw new Error('boom'); });
    expect(r).toBeUndefined();                       // fault tolerance preserved
    T.finish();
    expect(calls).toContainEqual({ name: 'step-b', state: 'failed', message: 'boom' });
  });

  it('degrades the job to failed and lists the failing steps when any step fails', async () => {
    const T = new StepTracker('job');
    await T.run('ok-1', async () => 1);
    await T.run('bad-1', async () => { throw new Error('x'); });
    await T.run('bad-2', async () => { throw new Error('y'); });
    T.finish();
    const job = calls.find(c => c.name === 'job');
    expect(job?.state).toBe('failed');
    expect(job?.message).toBe('2 steps failed: bad-1,bad-2');
  });
});
