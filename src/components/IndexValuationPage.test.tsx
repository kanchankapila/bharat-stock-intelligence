import { describe, expect, it } from 'vitest';
import { percentile, percentileRank } from './IndexValuationPage';

// Regression tests for the index-valuation percentile helpers (#11): the IQR band AND the
// "where does today sit" verdict both come from these two functions, so a silently wrong
// interpolation would mislabel every percentile on the page.
describe('percentile', () => {
  it('returns NaN for an empty history instead of throwing', () => {
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
  it('returns the only value for a single-point history', () => {
    expect(percentile([7], 0.9)).toBe(7);
  });
  it('hits the exact endpoints and median of a sorted series', () => {
    const s = [1, 2, 3, 4, 5];
    expect(percentile(s, 0)).toBe(1);
    expect(percentile(s, 0.5)).toBe(3);
    expect(percentile(s, 1)).toBe(5);
  });
  it('linearly interpolates between observations', () => {
    expect(percentile([0, 10], 0.25)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe('percentileRank', () => {
  it('returns NaN for an empty history', () => {
    expect(Number.isNaN(percentileRank([], 5))).toBe(true);
  });
  it('counts the share of observations at or below the value', () => {
    expect(percentileRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toBe(50);
    expect(percentileRank([1, 2, 3], 10)).toBe(100);
    expect(percentileRank([1, 2, 3], 0)).toBe(0);
  });
  it('treats ties as at-or-below (a value equal to every observation ranks 100)', () => {
    expect(percentileRank([5, 5, 5], 5)).toBe(100);
  });
});
