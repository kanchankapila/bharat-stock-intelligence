import { describe, it, expect } from 'vitest';
import { liquidityTier } from '../liquidityTier';

describe('liquidityTier (AF-20261015-10)', () => {
  it('labels the three tiers at the measured cuts', () => {
    expect(liquidityTier(0.4)).toBe('untradable');
    expect(liquidityTier(1)).toBe('thin');
    expect(liquidityTier(9.99)).toBe('thin');
    expect(liquidityTier(10)).toBe('ok');
    expect(liquidityTier(250)).toBe('ok');
  });

  it('returns null, never a tier, when turnover is unknown', () => {
    expect(liquidityTier(null)).toBeNull();
    expect(liquidityTier(undefined)).toBeNull();
    expect(liquidityTier(Number.NaN)).toBeNull();
  });
});
