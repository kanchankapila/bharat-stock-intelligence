import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getTrendlyneTaCircuitState,
  isTrendlyneTaBlocked,
  markTrendlyneTaBlocked,
  _resetTrendlyneTaCircuitForTests,
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
