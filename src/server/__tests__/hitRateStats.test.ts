import { describe, expect, it } from 'vitest';
import { hitRateUncertainty, wilson, withUncertainty } from '../hitRateStats';

describe('hit-rate uncertainty (AF-20261119-13)', () => {
  it('counts independent windows as distinct dates / horizon and flags LOW-DATA below 20', () => {
    const many = hitRateUncertainty({ dates: 150, max_horizon: 5, decided: 3000, wins: 1650 });
    expect(many.eff_windows).toBe(30);
    expect(many.low_data).toBe(false);
    const few = hitRateUncertainty({ dates: 60, max_horizon: 15, decided: 5000, wins: 2750 });
    expect(few.eff_windows).toBe(4);
    expect(few.low_data).toBe(true);
  });

  it('widens the interval for overlapping windows instead of trusting the raw row count', () => {
    const raw = wilson(1650, 3000)!;
    const u = hitRateUncertainty({ dates: 150, max_horizon: 5, decided: 3000, wins: 1650 });
    expect(u.win_ci_lo!).toBeLessThan(raw[0]);
    expect(u.win_ci_hi!).toBeGreaterThan(raw[1]);
    expect(u.win_ci_lo!).toBeLessThan(55);
    expect(u.win_ci_hi!).toBeGreaterThan(55);
  });

  it('reads stringified numerics from node-pg and handles empty cells', () => {
    expect(hitRateUncertainty({ dates: '40', max_horizon: '1', decided: '0', wins: '0' }).win_ci_lo).toBeNull();
    expect(hitRateUncertainty({}).low_data).toBe(true);
    expect(withUncertainty(null)).toBeNull();
    expect(withUncertainty({ total: 3, dates: 30, max_horizon: 1, decided: 3, wins: 2 })).toMatchObject({ total: 3, eff_windows: 30 });
  });
});
