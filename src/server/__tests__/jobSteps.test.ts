import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ name: string; state: string; message?: string }> = [];
vi.mock('../monitoringService', () => ({
  updateMonitorState: vi.fn((name: string, state: string, message?: string) => {
    calls.push({ name, state, message });
  }),
}));

import { StepTracker } from '../jobSteps';
import { updateMonitorState } from '../monitoringService';

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

  // runQuiet: the anti-swallow path. A failing sub-step must reach the job verdict WITHOUT
  // minting a per-step job_heartbeat row (getStaleJobs() would then flag it stale forever).
  it('runQuiet writes NO per-step monitor state but still fails the job verdict', async () => {
    const T = new StepTracker('job');
    const r = await T.runQuiet('quiet-step', async () => { throw new Error('quiet boom'); });
    expect(r).toBeUndefined();
    const verdict = T.finish();

    // the failure is NOT hidden: it reaches the job-level verdict and the failed-step list
    expect(verdict.ok).toBe(false);
    expect(verdict.failedSteps).toContain('quiet-step');
    expect(calls).toContainEqual({
      name: 'job', state: 'failed', message: '1 steps failed: quiet-step',
    });
    // ...but no heartbeat row is minted for the step itself
    expect(calls.some(c => c.name === 'quiet-step')).toBe(false);
  });

  it('runQuiet on success is silent and leaves the job green', async () => {
    const T = new StepTracker('job');
    const r = await T.runQuiet('quiet-ok', async () => 7);
    expect(r).toBe(7);
    const verdict = T.finish();
    expect(verdict.ok).toBe(true);
    expect(calls.some(c => c.name === 'quiet-ok')).toBe(false);
    expect(calls).toContainEqual({ name: 'job', state: 'success', message: undefined });
  });

  it('mixes tracked and quiet steps: only the tracked one gets a heartbeat', async () => {
    const T = new StepTracker('job');
    await T.run('tracked', async () => { throw new Error('t boom'); });
    await T.runQuiet('quiet', async () => { throw new Error('q boom'); });
    const verdict = T.finish();
    expect(verdict.failedSteps).toEqual(['tracked', 'quiet']);
    expect(calls).toContainEqual({ name: 'tracked', state: 'failed', message: 't boom' });
    expect(calls.some(c => c.name === 'quiet')).toBe(false);
  });

  it('fail() records a caught failure into the job verdict without a per-step heartbeat', async () => {
    const T = new StepTracker('job');
    // exactly the converted call-site shape
    await Promise.reject(new Error('py boom')).catch(e => T.fail('some_fetcher', e));
    const verdict = T.finish();
    expect(verdict.ok).toBe(false);
    expect(verdict.failedSteps).toContain('some_fetcher');
    expect(calls).toContainEqual({
      name: 'job', state: 'failed', message: '1 steps failed: some_fetcher',
    });
    expect(calls.some(c => c.name === 'some_fetcher')).toBe(false);
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

  // 2026-09-04, scheduler-review finding: _exec() already computed `ms` per step but
  // finish() discarded it before this fix -- job_run_history could never answer "which
  // step got slower." Asserts the 4th positional arg (opaque to the `calls` mock above,
  // which only captures the first 3), via the mock's own recorded call args.
  it('passes each step\'s measured duration through as the 4th updateMonitorState arg', async () => {
    const mocked = vi.mocked(updateMonitorState);
    mocked.mockClear();
    const T = new StepTracker('job');
    await T.run('slow-step', () => new Promise(resolve => setTimeout(() => resolve(1), 20)));
    T.finish();

    const stepCall = mocked.mock.calls.find(c => c[0] === 'slow-step');
    expect(stepCall).toBeDefined();
    expect(typeof stepCall![3]).toBe('number');
    expect(stepCall![3]).toBeGreaterThanOrEqual(15); // setTimeout(20) with slack for CI jitter

    // The job-level summary duration is the sum of its steps' ms, not left NULL either.
    const jobCall = mocked.mock.calls.find(c => c[0] === 'job');
    expect(typeof jobCall![3]).toBe('number');
    expect(jobCall![3]).toBeGreaterThanOrEqual(15);
  });
});
