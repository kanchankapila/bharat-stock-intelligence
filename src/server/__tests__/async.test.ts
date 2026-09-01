import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { delay, backoffDelay, withRetry, mapWithConcurrency } from '../lib/async';

describe('delay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves after the requested milliseconds', async () => {
    let resolved = false;
    const p = delay(500).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    await p;
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delay(100, controller.signal)).rejects.toThrow();
  });

  it('rejects when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const expectation = expect(delay(10_000, controller.signal)).rejects.toThrow();
    setTimeout(() => controller.abort(), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expectation;
  });
});

describe('backoffDelay', () => {
  it('doubles the base per 1-based attempt and caps the exponential component', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(10)).toBe(10000); // capped
    randomSpy.mockRestore();
  });

  it('adds uniform jitter in [0, jitterMs)', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffDelay(1)).toBe(1500);
    expect(backoffDelay(1, { baseMs: 500, capMs: 5000, jitterMs: 100 })).toBe(550);
    randomSpy.mockRestore();
  });
});

describe('withRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the first successful result without waiting', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { retries: 3 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries the configured number of times, passing 1-based attempt numbers', async () => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw new Error(`boom ${attempt}`);
      return attempt;
    });
    const onRetry = vi.fn();
    const p = withRetry(fn, { retries: 3, backoff: { jitterMs: 0 }, onRetry });
    // Two waits: attempt 1 -> 2 (1000ms), attempt 2 -> 3 (2000ms)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last error after exhausting retries', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    // Attach the rejection handler BEFORE advancing time, or the floating promise rejects
    // while advanceTimersByTimeAsync is awaiting and Node flags an unhandled rejection.
    const expectation = expect(withRetry(fn, { retries: 2, backoff: { jitterMs: 0 } })).rejects.toThrow('always fails');
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
    expect(fn).toHaveBeenCalledTimes(2);
    randomSpy.mockRestore();
  });

  it('stops immediately when retryOn declines', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    const expectation = expect(withRetry(fn, { retries: 5, retryOn: () => false })).rejects.toThrow('fatal');
    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports fixed per-gap delays', async () => {
    const fn = vi.fn(async (attempt: number) => {
      if (attempt === 1) throw new Error('transient');
      return 'done';
    });
    const p = withRetry(fn, { retries: 2, delays: [50] });
    await vi.advanceTimersByTimeAsync(49);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe('done');
    expect(settled).toBe(true);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      await delay(100 - n * 10); // earlier items sleep longer
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('never runs more than `limit` mappers concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(10 + n);
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty input without invoking the mapper', async () => {
    const mapper = vi.fn();
    await expect(mapWithConcurrency([], 5, mapper)).resolves.toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });
});
