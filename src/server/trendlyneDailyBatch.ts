/** Atomic completion accounting for the delayed Trendlyne daily symbol fan-out. */

const KEY_PREFIX = 'bharat:trendlyne-daily-batch:';
const TTL_SECONDS = 3 * 24 * 60 * 60;

type RedisHashClient = {
  hgetall(key: string): Promise<Record<string, string>>;
  hincrby(key: string, field: string, amount: number): Promise<number>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};

type QueueWithClient = { client: Promise<RedisHashClient> };

export type TrendlyneBatchVerdict = {
  done: boolean;
  success: boolean;
  total: number;
  completed: number;
  failed: number;
  durationMs: number;
};

export async function requireSuccessfulTrendlyneFetch(
  symbol: string,
  runner: (symbol: string) => Promise<boolean>,
): Promise<void> {
  if (!(await runner(symbol))) {
    throw new Error(`Trendlyne metrics fetch returned no durable data for ${symbol}`);
  }
}

const keyFor = (batchId: string) => `${KEY_PREFIX}${batchId}`;

export function trendlyneBatchId(
  existing: string | undefined,
  jobId: string | number | undefined,
  now = Date.now(),
): string {
  return existing || `trendlyne-${now}-${jobId ?? 'daily'}`;
}

export function trendlyneChildJobId(batchId: string, symbol: string): string {
  return `${batchId}-${symbol}`.replaceAll(':', '_');
}

export function trendlyneBatchVerdict(
  total: number,
  completed: number,
  failed: number,
  startedAt = Date.now(),
  now = Date.now(),
): TrendlyneBatchVerdict {
  const safeTotal = Math.max(0, total);
  const safeCompleted = Math.max(0, completed);
  const safeFailed = Math.max(0, failed);
  const done = safeCompleted + safeFailed >= safeTotal;
  return {
    done,
    success: done && safeFailed === 0,
    total: safeTotal,
    completed: safeCompleted,
    failed: safeFailed,
    durationMs: Math.max(0, now - startedAt),
  };
}

export async function initialiseTrendlyneBatch(
  queue: QueueWithClient,
  batchId: string,
  total: number,
  startedAt = Date.now(),
): Promise<void> {
  const client = await queue.client;
  const key = keyFor(batchId);
  const safeTotal = Math.max(0, total);
  await client.hsetnx(key, 'total', String(safeTotal));
  await client.hsetnx(key, 'completed', '0');
  await client.hsetnx(key, 'failed', '0');
  await client.hsetnx(key, 'startedAt', String(startedAt));
  const state = await client.hgetall(key);
  if (Number(state.total) !== safeTotal) {
    throw new Error(`batch total changed from ${state.total} to ${safeTotal} for ${batchId}`);
  }
  await client.expire(key, TTL_SECONDS);
}

/** Return a verdict exactly once, when the final child settles; otherwise return null. */
export async function settleTrendlyneBatch(
  queue: QueueWithClient,
  batchId: string,
  outcome: 'completed' | 'failed',
  now = Date.now(),
): Promise<TrendlyneBatchVerdict | null> {
  const client = await queue.client;
  const key = keyFor(batchId);
  const initial = await client.hgetall(key);
  if (initial.total === undefined || initial.startedAt === undefined) {
    throw new Error(`missing batch state for ${batchId}`);
  }
  await client.hincrby(key, outcome, 1);
  const state = await client.hgetall(key);
  const verdict = trendlyneBatchVerdict(
    Number(state.total || 0),
    Number(state.completed || 0),
    Number(state.failed || 0),
    Number(state.startedAt || now),
    now,
  );
  if (!verdict.done) return null;
  if (await client.hsetnx(key, 'finalised', '1') !== 1) return null;
  await client.expire(key, TTL_SECONDS);
  return verdict;
}
