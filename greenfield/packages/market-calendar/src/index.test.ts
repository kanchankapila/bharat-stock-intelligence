// Task 1.1 Verify: "unit tests covering a Monday after a Friday holiday, a
// post-midnight timestamp resolving to the previous session, and an
// unknown-date response before population." All three, pure, no DB.
import { expect, test } from 'vitest';
import {
  createSessionCalendar,
  isSession,
  logicalSession,
  nextSession,
  previousSession,
  sessionsBack,
  tradingDaysBetween,
} from './index.js';

// Thu 2026-08-13 trading, Fri 2026-08-14 a holiday (never observed as a
// session -- absent from the row set, matching how Stage 2's backfill derives
// the calendar: "a date returning 200 with >=1 accepted equity row IS a
// trading session," so a holiday just never gets a row at all), Mon 2026-08-17
// trading. Sat/Sun are likewise never observed.
const calendar = createSessionCalendar([
  { sessionDate: '2026-08-11', isHoliday: false }, // Tue
  { sessionDate: '2026-08-12', isHoliday: false }, // Wed
  { sessionDate: '2026-08-13', isHoliday: false }, // Thu
  { sessionDate: '2026-08-17', isHoliday: false }, // Mon
  { sessionDate: '2026-08-18', isHoliday: false }, // Tue
]);

test('previousSession skips the weekend and an unobserved Friday holiday', () => {
  expect(previousSession(calendar, '2026-08-17')).toBe('2026-08-13');
});

test('nextSession skips the same gap in the forward direction', () => {
  expect(nextSession(calendar, '2026-08-13')).toBe('2026-08-17');
});

test('sessionsBack walks N real trading sessions, not N calendar days', () => {
  expect(sessionsBack(calendar, '2026-08-18', 3)).toBe('2026-08-12');
});

test('tradingDaysBetween counts only real sessions in the range', () => {
  expect(tradingDaysBetween(calendar, '2026-08-11', '2026-08-18')).toBe(4);
});

test('isSession returns a real boolean once the date has been observed', () => {
  expect(isSession(calendar, '2026-08-13')).toBe(true);
});

test('isSession returns "unknown" for a date never observed -- not a guess', () => {
  const emptyCalendar = createSessionCalendar([]);
  expect(isSession(emptyCalendar, '2026-08-14')).toBe('unknown');
  // Same for a populated calendar queried about a date outside its range.
  expect(isSession(calendar, '2026-08-14')).toBe('unknown');
});

test('logicalSession resolves a post-midnight IST timestamp to the previous calendar date', () => {
  // 2026-08-13T19:15:00Z = 2026-08-14T00:45 IST -- 45 minutes past midnight,
  // well before the 09:15 IST open. Must resolve to 2026-08-13, not 2026-08-14.
  const postMidnight = new Date('2026-08-13T19:15:00Z');
  expect(logicalSession(postMidnight)).toBe('2026-08-13');
});

test('logicalSession resolves a mid-session IST timestamp to the same calendar date', () => {
  // 2026-08-13T10:00:00Z = 2026-08-13T15:30 IST -- mid-afternoon.
  const midSession = new Date('2026-08-13T10:00:00Z');
  expect(logicalSession(midSession)).toBe('2026-08-13');
});
