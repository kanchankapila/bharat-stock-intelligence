export interface RetryPolicy {
  attempts: number;
  backoffMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, backoffMs: 250, jitter: true };

/** Errors this SDK will retry: timeouts, connection resets, and 5xx. Never a
 * 404 -- for NSE archives (and most providers here) that is a semantically
 * meaningful "no data for this date" answer, not a transient failure
 * (BUILD_STAGE_0_2_SPEC.md Task 1.2). */
export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return error.status >= 500;
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return (
      error.name === 'AbortError' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNREFUSED'
    );
  }
  return false;
}

export class HttpStatusError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

function delayWithJitter(baseMs: number, attempt: number, jitter: boolean): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  if (!jitter) return exponential;
  // Full jitter: uniform random in [0, exponential] -- avoids synchronized
  // retry storms across concurrent requests hitting the same provider.
  return Math.random() * exponential;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === policy.attempts;
      if (isLastAttempt || !isRetryable(error)) {
        throw error;
      }
      await sleep(delayWithJitter(policy.backoffMs, attempt, policy.jitter));
    }
  }
  throw lastError;
}
