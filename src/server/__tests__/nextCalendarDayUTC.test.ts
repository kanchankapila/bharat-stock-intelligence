import { describe, it, expect } from 'vitest';
import { nextCalendarDayUTC } from '../routers/technicals.router';

// Regression coverage for the getTechnicalConfluenceSignals sargability fix: `date(cs.computed_at)
// = ?` wrapped the raw column and was replaced with a half-open [d, nextCalendarDayUTC(d)) range
// on the bare column. Boundary math like this is a classic off-by-one risk at month/year edges.
describe('nextCalendarDayUTC', () => {
  it('advances an ordinary day', () => {
    expect(nextCalendarDayUTC('2026-08-09')).toBe('2026-08-10');
  });

  it('rolls over a month boundary', () => {
    expect(nextCalendarDayUTC('2026-08-31')).toBe('2026-09-01');
  });

  it('rolls over a year boundary', () => {
    expect(nextCalendarDayUTC('2026-12-31')).toBe('2027-01-01');
  });

  it('handles a leap day correctly', () => {
    expect(nextCalendarDayUTC('2028-02-28')).toBe('2028-02-29');
    expect(nextCalendarDayUTC('2028-02-29')).toBe('2028-03-01');
  });

  it('does not roll over on a non-leap year February', () => {
    expect(nextCalendarDayUTC('2026-02-28')).toBe('2026-03-01');
  });
});
