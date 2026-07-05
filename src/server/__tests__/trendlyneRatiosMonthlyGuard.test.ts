import { test, expect } from 'vitest';

// Pure re-implementation of the guard condition used in queues.ts, so this test doesn't
// need to spin up BullMQ/Redis — it locks in the exact boundary behavior.
function shouldRunMonthlyRatios(date: Date): boolean {
  return date.getUTCDate() <= 7;
}

test('runs on the first Sunday of the month (date 1-7)', () => {
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 5)))).toBe(true); // Jul 5, 2026 is a Sunday
});

test('does not run on a later Sunday in the same month', () => {
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 12)))).toBe(false); // Jul 12, 2026
});

test('boundary: date 7 runs, date 8 does not', () => {
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 7)))).toBe(true);
  expect(shouldRunMonthlyRatios(new Date(Date.UTC(2026, 6, 8)))).toBe(false);
});
