import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTrendlyneTaCircuitState,
  isTrendlyneTaBlocked,
  markTrendlyneTaBlocked,
  _resetTrendlyneTaCircuitForTests,
  getTrendlyneStockMetricsCircuitState,
  isTrendlyneStockMetricsBlocked,
  markTrendlyneStockMetricsBlocked,
  _resetTrendlyneStockMetricsCircuitForTests,
} from '../trendlyneTechnicalCircuit';

describe('Trendlyne TA circuit', () => {
  beforeEach(() => _resetTrendlyneTaCircuitForTests());

  it('opens on a provider block and exposes the retry time', () => {
    markTrendlyneTaBlocked('405', 1_000, 5_000);
    expect(isTrendlyneTaBlocked(1_001)).toBe(true);
    expect(getTrendlyneTaCircuitState(1_001)).toEqual({
      open: true, reason: '405', retryAt: 6_000,
    });
    expect(isTrendlyneTaBlocked(6_000)).toBe(false);
  });
});

describe('Trendlyne stock-metrics circuit', () => {
  beforeEach(() => _resetTrendlyneStockMetricsCircuitForTests());

  it('opens on a WAF block and exposes the retry time', () => {
    markTrendlyneStockMetricsBlocked('429', 1_000, 5_000);
    expect(isTrendlyneStockMetricsBlocked(1_001)).toBe(true);
    expect(getTrendlyneStockMetricsCircuitState(1_001)).toEqual({
      open: true, reason: '429', retryAt: 6_000,
    });
    expect(isTrendlyneStockMetricsBlocked(6_000)).toBe(false);
  });

  it('opens on HTTP 500 and closes after cooldown', () => {
    markTrendlyneStockMetricsBlocked('500', 1_000, 5_000);
    expect(isTrendlyneStockMetricsBlocked(1_001)).toBe(true);
    expect(isTrendlyneStockMetricsBlocked(6_000)).toBe(false);
    expect(getTrendlyneStockMetricsCircuitState(6_000)).toEqual({
      open: false, reason: null, retryAt: null,
    });
  });
});
