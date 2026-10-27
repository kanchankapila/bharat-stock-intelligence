import { describe, expect, it, vi } from 'vitest';
import { cleanupTestPools } from '../vitest.setup';

// A mock-only suite must not load the real DB module for the first time at teardown.
vi.mock('../src/server/pgClient', () => { throw new Error('cleanup imported a DB module it never used'); });
const key = Symbol.for('bsi.vitest.pool-cleanups');

describe('registered test pool cleanup', () => {
  it('does nothing when the file never opened a pool, without importing pgClient', async () => {
    delete (globalThis as any)[key];
    await expect(cleanupTestPools()).resolves.toBeUndefined();
  });

  it('closes every registered module instance once and clears the registry', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const registry = new Set([first, second]);
    (globalThis as any)[key] = registry;
    await cleanupTestPools();
    await cleanupTestPools();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('still closes other pools and propagates a failed cleanup', async () => {
    const failure = new Error('pool did not close');
    const good = vi.fn().mockResolvedValue(undefined);
    (globalThis as any)[key] = new Set([() => Promise.reject(failure), good]);
    const error = await cleanupTestPools().catch(e => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toContain(failure);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
