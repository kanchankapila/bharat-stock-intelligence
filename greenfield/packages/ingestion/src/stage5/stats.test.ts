import { describe, expect, it } from 'vitest';
import { bonferroniCriticalT, inverseNormalCdf } from './stats.js';

describe('inverseNormalCdf', () => {
  it('matches well-known standard normal quantiles', () => {
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.995)).toBeCloseTo(2.575829, 5);
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 5);
  });

  it('is antisymmetric around 0.5', () => {
    expect(inverseNormalCdf(0.1)).toBeCloseTo(-inverseNormalCdf(0.9), 8);
  });

  it('negative control: rejects p outside (0,1)', () => {
    expect(() => inverseNormalCdf(0)).toThrow();
    expect(() => inverseNormalCdf(1)).toThrow();
    expect(() => inverseNormalCdf(-0.1)).toThrow();
  });
});

describe('bonferroniCriticalT', () => {
  it('reduces to the ordinary two-tailed 1.96 critical value at n=1 comparison', () => {
    expect(bonferroniCriticalT(1)).toBeCloseTo(1.959964, 3);
  });

  it('computes the real value for 24 comparisons (12 factors x 2 horizons) -- ~3.08, not the spec draft\'s hand-estimated "~3.4"', () => {
    const t = bonferroniCriticalT(24);
    expect(t).toBeGreaterThan(3.0);
    expect(t).toBeLessThan(3.15);
  });

  it('the threshold gets strictly more conservative as more comparisons are added', () => {
    expect(bonferroniCriticalT(24)).toBeGreaterThan(bonferroniCriticalT(12));
    expect(bonferroniCriticalT(48)).toBeGreaterThan(bonferroniCriticalT(24));
  });
});
