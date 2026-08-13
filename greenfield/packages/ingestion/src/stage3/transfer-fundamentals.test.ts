import { describe, expect, it } from 'vitest';
import { availableAtFloor } from './transfer-fundamentals.js';

// Pins the exact bug found live via fundamentals-lag-floor's negative
// control: a first fix (cap available_at at fetch time) stopped future-dating
// but then wrote 104,100 rows that violated the 90-day floor itself -- the
// two constraints (never future, never before periodEnd+90d) are only both
// satisfiable by withholding the fact entirely until the floor has passed.
describe('availableAtFloor', () => {
  const LAG_DAYS = 90;

  it('returns periodEnd+90d when that floor has already passed by fetch time', () => {
    const result = availableAtFloor('2025-01-01', LAG_DAYS, '2026-01-01T00:00:00.000Z');
    expect(result).toBe('2025-04-01T00:00:00.000Z');
  });

  it('negative control: never returns a date after fetchedAt (no future-dating)', () => {
    const fetchedAt = '2026-08-13T00:00:00.000Z';
    const result = availableAtFloor('2026-06-30', LAG_DAYS, fetchedAt); // floor would be 2026-09-28, after fetchedAt
    if (result !== null) expect(result <= fetchedAt).toBe(true);
  });

  it('negative control: never returns a date before periodEnd+90d (no lag-floor violation)', () => {
    const fetchedAt = '2026-08-13T00:00:00.000Z';
    const result = availableAtFloor('2026-06-30', LAG_DAYS, fetchedAt);
    const floor = '2026-09-28T00:00:00.000Z';
    if (result !== null) expect(result >= floor).toBe(true);
  });

  it('returns null (withheld) rather than violating either constraint when the floor has not yet passed', () => {
    const result = availableAtFloor('2026-06-30', LAG_DAYS, '2026-08-13T00:00:00.000Z');
    expect(result).toBeNull();
  });

  it('returns exactly fetchedAt when fetch happens exactly on the floor date', () => {
    const result = availableAtFloor('2026-01-01', LAG_DAYS, '2026-04-01T00:00:00.000Z');
    expect(result).toBe('2026-04-01T00:00:00.000Z');
  });
});
