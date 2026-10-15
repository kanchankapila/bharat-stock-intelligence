import { describe, expect, it } from 'vitest';

import {
  initialiseTrendlyneBatch,
  requireSuccessfulTrendlyneFetch,
  settleTrendlyneBatch,
  trendlyneBatchId,
  trendlyneBatchVerdict,
  trendlyneChildJobId,
} from '../trendlyneDailyBatch';

class FakeRedis {
  hashes = new Map<string, Record<string, string>>();

  async hset(key: string, ...args: string[]) {
    const hash = this.hashes.get(key) ?? {};
    for (let i = 0; i < args.length; i += 2) hash[args[i]] = args[i + 1];
    this.hashes.set(key, hash);
    return 1;
  }

  async hgetall(key: string) { return { ...(this.hashes.get(key) ?? {}) }; }
  async hincrby(key: string, field: string, amount: number) {
    const hash = this.hashes.get(key) ?? {};
    hash[field] = String(Number(hash[field] ?? 0) + amount);
    this.hashes.set(key, hash);
    return Number(hash[field]);
  }
  async hsetnx(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) ?? {};
    if (field in hash) return 0;
    hash[field] = value;
    this.hashes.set(key, hash);
    return 1;
  }
  async expire() { return 1; }
}

const fakeQueue = () => ({ client: Promise.resolve(new FakeRedis()) });

describe('Trendlyne daily batch accounting', () => {
  it('reuses parent identity across retries and emits BullMQ-safe child ids', () => {
    expect(trendlyneBatchId(undefined, 'repeat:abc', 100)).toBe('trendlyne-100-repeat:abc');
    expect(trendlyneBatchId('existing', 'repeat:abc', 200)).toBe('existing');
    expect(trendlyneChildJobId('trendlyne-100-repeat:abc', 'M&M')).toBe(
      'trendlyne-100-repeat_abc-M&M',
    );
  });

  it('turns a fetcher false result into a retryable worker failure', async () => {
    await expect(requireSuccessfulTrendlyneFetch('AAA', async () => false)).rejects.toThrow(
      /no durable data for AAA/,
    );
    await expect(requireSuccessfulTrendlyneFetch('AAA', async () => true)).resolves.toBeUndefined();
  });

  it('does not call an enqueued fan-out complete while children remain', () => {
    expect(trendlyneBatchVerdict(500, 499, 0, 100, 200)).toMatchObject({
      done: false,
      success: false,
    });
  });

  it('reports success only when every child succeeds', async () => {
    const queue = fakeQueue();
    await initialiseTrendlyneBatch(queue, 'green', 2, 100);
    expect(await settleTrendlyneBatch(queue, 'green', 'completed', 150)).toBeNull();
    expect(await settleTrendlyneBatch(queue, 'green', 'completed', 200)).toEqual({
      done: true,
      success: true,
      total: 2,
      completed: 2,
      failed: 0,
      durationMs: 100,
    });
  });

  it('reports one aggregate failure and cannot be finalised twice', async () => {
    const queue = fakeQueue();
    await initialiseTrendlyneBatch(queue, 'red', 2, 100);
    expect(await settleTrendlyneBatch(queue, 'red', 'completed', 150)).toBeNull();
    expect(await settleTrendlyneBatch(queue, 'red', 'failed', 200)).toMatchObject({
      done: true,
      success: false,
      completed: 1,
      failed: 1,
    });
    expect(await settleTrendlyneBatch(queue, 'red', 'completed', 250)).toBeNull();
  });

  it('does not reset settled children when the parent retries batch initialisation', async () => {
    const queue = fakeQueue();
    await initialiseTrendlyneBatch(queue, 'retry', 2, 100);
    expect(await settleTrendlyneBatch(queue, 'retry', 'completed', 150)).toBeNull();
    await initialiseTrendlyneBatch(queue, 'retry', 2, 175);
    expect(await settleTrendlyneBatch(queue, 'retry', 'completed', 200)).toMatchObject({
      done: true,
      success: true,
      completed: 2,
      durationMs: 100,
    });
  });

  it('fails closed if a retry sees a different universe size for the same batch', async () => {
    const queue = fakeQueue();
    await initialiseTrendlyneBatch(queue, 'changed-universe', 2, 100);

    await expect(
      initialiseTrendlyneBatch(queue, 'changed-universe', 3, 175),
    ).rejects.toThrow(/batch total changed from 2 to 3/);
  });

  it('refuses to invent a completed batch when its Redis state is missing', async () => {
    const queue = fakeQueue();
    await expect(settleTrendlyneBatch(queue, 'missing', 'completed', 200)).rejects.toThrow(
      /missing batch state/,
    );
  });
});
