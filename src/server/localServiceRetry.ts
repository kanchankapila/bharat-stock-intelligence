/**
 * Retry a call to one of this box's OWN Python services across a momentary restart.
 *
 * Measured 2026-09-17 over 30 days of job_run_history, three daily jobs fail this way and
 * nothing about the failure is a real error:
 *
 *   stock-scoring        10/32 failed   "Stock scoring failed: fetch failed"
 *   chatbot-reingest      9/38 failed   "fetch failed"
 *   ml-ensemble-score     3/22 failed   "connect ECONNREFUSED 127.0.0.1:8000"
 *
 * ml-api, chatbot, alphaquant and engine-worker are pm2 apps on this same host; `pm2 restart`,
 * a memory-ceiling kill or the host's own reboot leaves a seconds-to-minutes window in which
 * the port refuses connections. A job that happens to fire inside that window is recorded as a
 * failure, inflates the job's fail-rate metric, and reaches the Telegram digest as if the
 * pipeline were broken.
 *
 * Retries ONLY a connection-level failure -- the service was not reachable at all. An HTTP
 * response of any status (including 500) means the service answered and the failure is real:
 * retrying it would re-run work that already ran, and would hide a genuine defect behind
 * three identical stack traces. That distinction is the whole point of this helper; a blanket
 * retry would be strictly worse than no retry.
 */

/** Node surfaces a refused/reset local connection several ways depending on the client
 *  (undici `fetch` wraps the cause; axios exposes `code`), so match on all of them. */
export function isConnectionError(err: unknown): boolean {
  const CODES = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT'];
  const seen = new Set<unknown>();
  let e: any = err;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    if (typeof e.code === 'string' && CODES.includes(e.code)) return true;
    // undici: `TypeError: fetch failed` with the real reason on `.cause`
    if (e.message === 'fetch failed') return true;
    e = e.cause;
  }
  return false;
}

export interface RetryOpts { attempts?: number; baseDelayMs?: number; label?: string; }

export async function retryOnConnectionError<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 5_000, label = 'local service' }: RetryOpts = {},
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isConnectionError(err) || i === attempts - 1) throw err;
      const wait = baseDelayMs * 2 ** i;   // 5s, 10s -- covers a pm2 restart, not an outage
      console.warn(
        `[retry] ${label} unreachable (${(err as Error)?.message ?? err}); ` +
        `attempt ${i + 1}/${attempts}, retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}
