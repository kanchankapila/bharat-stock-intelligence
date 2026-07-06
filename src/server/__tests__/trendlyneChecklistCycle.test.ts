import { describe, test, expect } from 'vitest';
import {
  isDormant,
  shouldStartNewCycle,
  pickRandomBatch,
  randomDelayMs,
  CYCLE_PAUSE_MS,
} from '../trendlyneChecklistCycle';

describe('isDormant', () => {
  test('false when no cycle has ever completed', () => {
    expect(isDormant(Date.now(), null)).toBe(false);
  });

  test('true immediately after a cycle completes', () => {
    const now = Date.now();
    expect(isDormant(now, now - 1000)).toBe(true);
  });

  test('true right before the 30-day pause elapses', () => {
    const now = Date.now();
    const completedAt = now - CYCLE_PAUSE_MS + 60_000; // 1 min before pause ends
    expect(isDormant(now, completedAt)).toBe(true);
  });

  test('false once the 30-day pause has elapsed', () => {
    const now = Date.now();
    const completedAt = now - CYCLE_PAUSE_MS - 1000; // 1 sec past pause end
    expect(isDormant(now, completedAt)).toBe(false);
  });
});

describe('shouldStartNewCycle', () => {
  test('true when no cycle has ever started', () => {
    expect(shouldStartNewCycle(null, null, Date.now())).toBe(true);
  });

  test('false mid-cycle (started, not yet completed)', () => {
    const now = Date.now();
    expect(shouldStartNewCycle(now - 1000, null, now)).toBe(false);
  });

  test('false during the dormant pause after completion', () => {
    const now = Date.now();
    expect(shouldStartNewCycle(now - 1_000_000, now - 1000, now)).toBe(false);
  });

  test('true once the 30-day pause has elapsed', () => {
    const now = Date.now();
    const completedAt = now - CYCLE_PAUSE_MS - 1000;
    expect(shouldStartNewCycle(now - 2_000_000, completedAt, now)).toBe(true);
  });
});

describe('pickRandomBatch', () => {
  test('returns a slice within [minSize, maxSize]', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const batch = pickRandomBatch(items, 10, 15);
    expect(batch.length).toBeGreaterThanOrEqual(10);
    expect(batch.length).toBeLessThanOrEqual(15);
  });

  test('never returns more items than available', () => {
    const items = [1, 2, 3];
    const batch = pickRandomBatch(items, 10, 15);
    expect(batch.length).toBeLessThanOrEqual(3);
  });

  test('only returns items present in the input, no duplicates', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const batch = pickRandomBatch(items, 10, 15);
    expect(new Set(batch).size).toBe(batch.length);
    for (const x of batch) expect(items).toContain(x);
  });
});

describe('randomDelayMs', () => {
  test('returns a value within [min, max] minutes converted to ms', () => {
    const ms = randomDelayMs(15, 45);
    expect(ms).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(45 * 60 * 1000);
  });
});
