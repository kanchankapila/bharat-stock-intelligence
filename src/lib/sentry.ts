/**
 * Sentry error tracking (frontend). Fully env-gated: with no VITE_SENTRY_DSN set, initSentry()
 * is a no-op and captureException() silently does nothing — the app behaves exactly as before
 * this file existed. Init happens in main.tsx before the app renders.
 */
import * as Sentry from '@sentry/react';

let _initialized = false;

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) {
    console.log('[Sentry] VITE_SENTRY_DSN not set — error tracking disabled.');
    return;
  }
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Errors only by default — tracing/session-replay sampling is a separate cost decision.
    tracesSampleRate: 0,
  });
  _initialized = true;
  console.log('[Sentry] Initialized.');
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  if (!_initialized) return;
  Sentry.captureException(error, extra ? { extra } : undefined);
}
