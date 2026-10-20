/**
 * Process-wide circuits for Trendlyne endpoints.
 *
 * Trendlyne returns HTTP 403/405/429 from its WAF after the cumulative request allowance is exhausted.
 * The endpoint itself is a valid GET (verified in the endpoint registry and by a live probe);
 * treating WAF blocks as transient errors or retrying them only spends more of the blocked
 * allowance. Each circuit is intentionally local to its endpoint: different Trendlyne APIs have
 * different WAF/rate contracts.
 */
export const TRENDLYNE_TA_BLOCK_COOLDOWN_MS = 10 * 60 * 1000;
export const TRENDLYNE_STOCK_METRICS_BLOCK_COOLDOWN_MS = 10 * 60 * 1000;

export type TrendlyneTaBlockReason = '403' | '405' | '429';
export type TrendlyneStockMetricsBlockReason = '403' | '429' | '500';

export interface TrendlyneTaCircuitState {
  open: boolean;
  reason: TrendlyneTaBlockReason | null;
  retryAt: number | null;
}

export interface TrendlyneStockMetricsCircuitState {
  open: boolean;
  reason: TrendlyneStockMetricsBlockReason | null;
  retryAt: number | null;
}

let taBlockedUntil = 0;
let taBlockReason: TrendlyneTaBlockReason | null = null;

let stockMetricsBlockedUntil = 0;
let stockMetricsBlockReason: TrendlyneStockMetricsBlockReason | null = null;

export function markTrendlyneTaBlocked(
  reason: TrendlyneTaBlockReason,
  now = Date.now(),
  cooldownMs = TRENDLYNE_TA_BLOCK_COOLDOWN_MS,
): void {
  taBlockedUntil = now + Math.max(0, cooldownMs);
  taBlockReason = reason;
}

export function getTrendlyneTaCircuitState(now = Date.now()): TrendlyneTaCircuitState {
  const open = now < taBlockedUntil;
  if (!open) {
    taBlockedUntil = 0;
    taBlockReason = null;
  }
  return {
    open,
    reason: open ? taBlockReason : null,
    retryAt: open ? taBlockedUntil : null,
  };
}

export function isTrendlyneTaBlocked(now = Date.now()): boolean {
  return getTrendlyneTaCircuitState(now).open;
}

/** Test seam; production callers must not reset a live block. */
export function _resetTrendlyneTaCircuitForTests(): void {
  taBlockedUntil = 0;
  taBlockReason = null;
}

export function markTrendlyneStockMetricsBlocked(
  reason: TrendlyneStockMetricsBlockReason,
  now = Date.now(),
  cooldownMs = TRENDLYNE_STOCK_METRICS_BLOCK_COOLDOWN_MS,
): void {
  stockMetricsBlockedUntil = now + Math.max(0, cooldownMs);
  stockMetricsBlockReason = reason;
}

export function getTrendlyneStockMetricsCircuitState(
  now = Date.now(),
): TrendlyneStockMetricsCircuitState {
  const open = now < stockMetricsBlockedUntil;
  if (!open) {
    stockMetricsBlockedUntil = 0;
    stockMetricsBlockReason = null;
  }
  return {
    open,
    reason: open ? stockMetricsBlockReason : null,
    retryAt: open ? stockMetricsBlockedUntil : null,
  };
}

export function isTrendlyneStockMetricsBlocked(now = Date.now()): boolean {
  return getTrendlyneStockMetricsCircuitState(now).open;
}

/** Test seam; production callers must not reset a live block. */
export function _resetTrendlyneStockMetricsCircuitForTests(): void {
  stockMetricsBlockedUntil = 0;
  stockMetricsBlockReason = null;
}
