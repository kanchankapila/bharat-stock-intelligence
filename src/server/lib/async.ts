/**
 * Shared async primitives for the server's I/O paths.
 *
 * Consolidates the delay/backoff/concurrency patterns that were re-implemented
 * inline at ~10 call sites (mcApiService.ts's two identical backoff formulas,
 * the per-file `sleep()` helpers in the auth services, and the
 * `new Promise(resolve => setTimeout(resolve, N))` one-liners sprinkled through
 * the screener syncs). Every function here is behavior-compatible with the code
 * it replaces — same 1-based attempt numbering, same
 * `min(base * 2^(attempt-1), cap) + random jitter` distribution — so call sites
 * can adopt it mechanically.
 */

/** Promise-based sleep. Rejects promptly if `signal` aborts while sleeping. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface BackoffOptions {
  /** Delay for attempt 1 (ms). Default 1000. */
  baseMs?: number;
  /** Ceiling on the exponential component (ms). Default 10000. */
  capMs?: number;
  /** Full-width random addition (ms), uniform in [0, jitterMs). Default 1000. */
  jitterMs?: number;
}

/**
 * Exponential backoff with full jitter for a 1-based `attempt`:
 * `min(baseMs * 2^(attempt-1), capMs) + random(0..jitterMs)`.
 * Matches the formula previously inlined in mcApiService.ts exactly.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1000, capMs = 10000, jitterMs = 1000 } = opts;
  return Math.min(baseMs * Math.pow(2, attempt - 1), capMs) + Math.random() * jitterMs;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  retries?: number;
  /** Passed through to backoffDelay between attempts. */
  backoff?: BackoffOptions;
  /** Override delays with fixed values per gap: delays[0] sits between attempt 1 and 2. */
  delays?: number[];
  /** Return false to rethrow immediately (e.g. only retry transient errors). Default: retry all. */
  retryOn?: (err: unknown, attempt: number) => boolean;
  /** Observability hook — fired before each wait, mirroring the per-site warn logs it replaces. */
  onRetry?: (err: unknown, attempt: number, retries: number, waitMs: number) => void;
  /** Aborts between attempts (a rejection from the in-flight attempt still propagates first). */
  signal?: AbortSignal;
}

/**
 * Run `fn` up to `retries` times, waiting on exponential backoff between failures.
 * `fn` receives the 1-based attempt number. Rethrows the last error if all attempts
 * fail or `retryOn` declines.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      if (opts.retryOn && !opts.retryOn(err, attempt)) break;
      const waitMs = opts.delays?.[attempt - 1] ?? backoffDelay(attempt, opts.backoff);
      opts.onRetry?.(err, attempt, retries, waitMs);
      await delay(waitMs, opts.signal);
    }
  }
  throw lastErr;
}

/**
 * Map with bounded concurrency, preserving input order in the result.
 * A rejected mapper rejects the whole call but does not start further items
 * beyond those already in flight.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const maxInFlight = Math.max(1, Math.floor(limit));
  let next = 0;
  const workers = Array.from({ length: Math.min(maxInFlight, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
