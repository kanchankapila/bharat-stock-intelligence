/**
 * Sentry error tracking (backend). Fully env-gated: with no SENTRY_DSN set, initSentry() is
 * a no-op and the app behaves exactly as before this file existed. Init happens as early as
 * possible in server.ts (right after dotenv/config) so it can capture startup-path errors too.
 */
import * as Sentry from '@sentry/node';

let _initialized = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[Sentry] SENTRY_DSN not set — error tracking disabled.');
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Errors only by default — tracing/profiling sampling is a separate, paid-tier cost
    // decision; leave at 0 until explicitly opted into via SENTRY_TRACES_SAMPLE_RATE.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  });
  _initialized = true;
  console.log('[Sentry] Initialized.');
}

export function sentryEnabled(): boolean {
  return _initialized;
}

export { Sentry };
