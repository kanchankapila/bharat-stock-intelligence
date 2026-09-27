/**
 * Process-wide circuit for Trendlyne's advanced-technical endpoint.
 *
 * Trendlyne returns HTTP 405 from its WAF after the cumulative request allowance is exhausted.
 * The endpoint itself is a valid GET (verified in the endpoint registry and by a live probe);
 * treating 405 as a method error or retrying it three times only spends more of the blocked
 * allowance. The circuit is intentionally local to this endpoint: other Trendlyne APIs have
 * different WAF/rate contracts.
 */
export const TRENDLYNE_TA_BLOCK_COOLDOWN_MS = 10 * 60 * 1000;

export type TrendlyneTaBlockReason = '403' | '405' | '429';

export interface TrendlyneTaCircuitState {
  open: boolean;
  reason: TrendlyneTaBlockReason | null;
  retryAt: number | null;
}

let blockedUntil = 0;
let blockReason: TrendlyneTaBlockReason | null = null;

export function markTrendlyneTaBlocked(
  reason: TrendlyneTaBlockReason,
  now = Date.now(),
  cooldownMs = TRENDLYNE_TA_BLOCK_COOLDOWN_MS,
): void {
  blockedUntil = now + Math.max(0, cooldownMs);
  blockReason = reason;
}

export function getTrendlyneTaCircuitState(now = Date.now()): TrendlyneTaCircuitState {
  const open = now < blockedUntil;
  if (!open) {
    blockedUntil = 0;
    blockReason = null;
  }
  return {
    open,
    reason: open ? blockReason : null,
    retryAt: open ? blockedUntil : null,
  };
}

export function isTrendlyneTaBlocked(now = Date.now()): boolean {
  return getTrendlyneTaCircuitState(now).open;
}

/** Test seam; production callers must not reset a live block. */
export function _resetTrendlyneTaCircuitForTests(): void {
  blockedUntil = 0;
  blockReason = null;
}
