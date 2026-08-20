import { describe, it, expect } from 'vitest';
import { dayRangePct } from '../IndexKpiCard';

describe('dayRangePct', () => {
  it('falls back to a neutral 50% when dayLow/dayHigh are absent (the only path today)', () => {
    expect(dayRangePct(24_200)).toBe(50);
    expect(dayRangePct(24_200, null, null)).toBe(50);
    expect(dayRangePct(24_200, undefined, 24_500)).toBe(50);
  });

  it('falls back to 50% on a degenerate range (dayHigh <= dayLow)', () => {
    expect(dayRangePct(24_200, 24_500, 24_500)).toBe(50);
    expect(dayRangePct(24_200, 24_600, 24_500)).toBe(50);
  });

  it('computes the real position once a valid range is provided', () => {
    expect(dayRangePct(24_300, 24_200, 24_400)).toBe(50);
    expect(dayRangePct(24_400, 24_200, 24_400)).toBe(100);
    expect(dayRangePct(24_200, 24_200, 24_400)).toBe(0);
  });

  it('clamps outside the range instead of overflowing', () => {
    expect(dayRangePct(24_100, 24_200, 24_400)).toBe(0);
    expect(dayRangePct(24_500, 24_200, 24_400)).toBe(100);
  });
});
