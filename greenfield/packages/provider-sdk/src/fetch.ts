import { createHash } from 'node:crypto';
import { HttpStatusError, withRetry, type RetryPolicy, DEFAULT_RETRY } from './retry.js';

export { HttpStatusError } from './retry.js';

export interface RawCapture {
  httpStatus: number;
  contentType: string | null;
  contentHash: string;
  byteSize: number;
  body: string;
}

export interface FetchPolicyOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retry?: RetryPolicy;
  maxBytes?: number;
}

export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeded the ${maxBytes}-byte cap`);
    this.name = 'ResponseTooLargeError';
  }
}

/** Redact common secret-shaped header values before anything is logged.
 * "Secrets in a managed store, never logs or client bundles" (B9). */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const SECRET_KEYS = /authorization|cookie|api[-_]?key|token|secret|password/i;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_KEYS.test(key) ? '[REDACTED]' : value;
  }
  return out;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Some providers (NSE's own site API, not the archive) reject a bare
 * request without a prior session cookie. This primes one with a single GET
 * and returns the raw Set-Cookie value(s) joined for reuse as a Cookie
 * header on the real request -- no retry policy, no raw_object capture; the
 * priming request itself is not the data being fetched. Returns '' if the
 * priming request fails or sets no cookie (caller decides whether that's
 * fatal -- some endpoints tolerate a missing cookie). */
export async function primeSessionCookie(url: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return setCookie.map((c) => c.split(';')[0]).join('; ');
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** One HTTP request with timeout, bounded retry+jitter (never on 404), and a
 * response size cap. Returns a raw capture -- caller persists it as
 * raw_object BEFORE parsing (BUILD_STAGE_0_2_SPEC.md §1: "raw before parse").
 * HTTP 200 is not itself success; the caller still owns schema validation. */
export async function fetchWithPolicy(opts: FetchPolicyOptions): Promise<RawCapture> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 20_000_000;

  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(opts.url, {
        method: opts.method ?? 'GET',
        // exactOptionalPropertyTypes rejects `headers: undefined` explicitly,
        // so only include the key when a value was actually given.
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        signal: controller.signal,
      });

      if (response.status === 404) {
        // Not retryable and not necessarily an error -- the caller decides
        // (e.g. NSE bhavcopy: 404 means non-trading day). Surface the real
        // status so the caller can branch on it.
        const body = await readCapped(response, maxBytes);
        return {
          httpStatus: 404,
          contentType: response.headers.get('content-type'),
          contentHash: createHash('sha256').update(body).digest('hex'),
          byteSize: Buffer.byteLength(body),
          body,
        };
      }

      if (response.status >= 500) {
        throw new HttpStatusError(response.status, `${opts.url} -> HTTP ${response.status}`);
      }

      const body = await readCapped(response, maxBytes);
      return {
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        contentHash: createHash('sha256').update(body).digest('hex'),
        byteSize: Buffer.byteLength(body),
        body,
      };
    } finally {
      clearTimeout(timer);
    }
  }, opts.retry ?? DEFAULT_RETRY);
}
