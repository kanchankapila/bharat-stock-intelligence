// Task 1.1 Verify: "unit tests covering a Monday after a Friday holiday, a
// post-midnight timestamp resolving to the previous session, and an
// unknown-date response before population." All three, pure, no DB.
import { expect, test } from 'vitest';
import {
  createSessionCalendar,
  isSession,
  isWithinScheduleWindow,
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

// Live incident, 2026-09-03: a pm2 ecosystem restart at 09:20 IST fired every gf-* cron_restart
// job immediately, including gf-bhavcopy-daily (meant for 19:30 IST weekdays only). Reproduces
// the exact timestamps involved.
test('isWithinScheduleWindow rejects a pm2-registration launch far from the real fire time', () => {
  const spuriousLaunch = new Date('2026-09-03T03:50:00Z'); // 09:20 IST, a Thursday
  expect(
    isWithinScheduleWindow(spuriousLaunch, { hour: 19, minute: 30, daysOfWeek: [1, 2, 3, 4, 5] }),
  ).toBe(false);
});

test('isWithinScheduleWindow accepts the real cron fire at its intended time', () => {
  const realFire = new Date('2026-09-03T14:00:00Z'); // 19:30 IST, the same Thursday
  expect(
    isWithinScheduleWindow(realFire, { hour: 19, minute: 30, daysOfWeek: [1, 2, 3, 4, 5] }),
  ).toBe(true);
});

test('isWithinScheduleWindow, at a wider explicit tolerance, still accepts a late fire', () => {
  // Not a claim any real cron_restart job legitimately fires late (it doesn't -- croner fires
  // at the exact minute, and the guard runs before any DB/network work) -- just exercises the
  // tolerance parameter's general behaviour at a value wider than the 5-min default.
  const late = new Date('2026-09-03T14:47:00Z'); // 20:17 IST -- 47 min past target
  expect(
    isWithinScheduleWindow(late, { hour: 19, minute: 30, daysOfWeek: [1, 2, 3, 4, 5] }, 60),
  ).toBe(true);
});

test('isWithinScheduleWindow rejects the right time on the wrong day for a weekly job', () => {
  // A Saturday-only job (gf-fundamentals-weekly, 09:30 IST) launched by the same Thursday
  // pm2 restart -- the time matches almost exactly, only the day is wrong.
  const wrongDay = new Date('2026-09-03T04:01:00Z'); // 09:31 IST, Thursday not Saturday
  expect(isWithinScheduleWindow(wrongDay, { hour: 9, minute: 30, daysOfWeek: [6] })).toBe(false);
});

test('isWithinScheduleWindow handles the midnight wraparound correctly', () => {
  // Target 23:15 IST (pg-backup-nightly); a fire at 23:18 IST is 3 min past target, not
  // ~23h58m the wrong way round the clock -- must not naively subtract across the day boundary.
  const nearMidnight = new Date('2026-09-03T17:48:00Z'); // 2026-09-03T23:18 IST
  expect(isWithinScheduleWindow(nearMidnight, { hour: 23, minute: 15 })).toBe(true);
});

// Regression for the code-review finding that a wider tolerance would let a single off-schedule
// pm2 restart land inside the evening chain's own 10-min job spacing (21:30/21:40/21:50/22:00
// IST in ecosystem.config.cjs) and pass the guard for several neighbouring jobs AT ONCE --
// reproducing a smaller-scale version of the original incident (multiple stages firing together,
// out of their intended order) instead of closing it. At the 5-min default, a restart roughly
// midway between two 10-min-apart jobs must be rejected by BOTH, not accepted by either.
test('isWithinScheduleWindow: a restart midway between two 10-min-apart evening jobs is rejected by both', () => {
  const midway = new Date('2026-09-03T16:15:00Z'); // 21:45 IST -- exactly between 21:40 and 21:50
  expect(isWithinScheduleWindow(midway, { hour: 21, minute: 40, daysOfWeek: [1, 2, 3, 4, 5] })).toBe(false); // stage3-dq
  expect(isWithinScheduleWindow(midway, { hour: 21, minute: 50, daysOfWeek: [1, 2, 3, 4, 5] })).toBe(false); // stage4-dq
});
