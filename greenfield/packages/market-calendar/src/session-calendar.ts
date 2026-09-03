// Pure, DB-agnostic calendar logic -- GREENFIELD_BUILD_SPEC.md B8 classifies
// calendar math as a unit-testable pure function, and the import-boundary
// matrix only allows this package to import contracts, not db. The caller
// (packages/db or apps/worker) is responsible for querying trading_session
// and building a SessionCalendar; this package never touches Postgres.
//
// "Only market-calendar computes trading dates" (GREENFIELD_STOCK_ANALYSIS_
// ARCHITECTURE.md invariant #6) means every OTHER package must route through
// these functions instead of new Date()/weekday arithmetic -- not that this
// package owns a database connection.

export interface SessionCalendar {
  /** true = trading day, false = known non-session (holiday/weekend observed
   * as absent), undefined = not yet known -- BUILD_STAGE_0_2_SPEC.md Task 1.1:
   * "Before Stage 2 populates that table, isSession returns 'unknown' rather
   * than guessing -- it must not fall back to weekday arithmetic." */
  status(date: string): boolean | undefined;
  /** Ascending-sorted list of known trading (non-holiday) session dates. */
  tradingDates(): readonly string[];
}

export function createSessionCalendar(
  rows: ReadonlyArray<{ sessionDate: string; isHoliday: boolean }>,
): SessionCalendar {
  const byDate = new Map<string, boolean>();
  for (const row of rows) {
    byDate.set(row.sessionDate, !row.isHoliday);
  }
  const tradingDates = [...byDate.entries()]
    .filter(([, isTrading]) => isTrading)
    .map(([date]) => date)
    .sort();

  return {
    status(date: string): boolean | undefined {
      return byDate.get(date);
    },
    tradingDates(): readonly string[] {
      return tradingDates;
    },
  };
}

export function isSession(calendar: SessionCalendar, date: string): boolean | 'unknown' {
  const status = calendar.status(date);
  return status === undefined ? 'unknown' : status;
}

export function previousSession(calendar: SessionCalendar, date: string): string | null {
  const dates = calendar.tradingDates();
  let result: string | null = null;
  for (const d of dates) {
    if (d >= date) break;
    result = d;
  }
  return result;
}

export function nextSession(calendar: SessionCalendar, date: string): string | null {
  for (const d of calendar.tradingDates()) {
    if (d > date) return d;
  }
  return null;
}

export function sessionsBack(calendar: SessionCalendar, date: string, n: number): string | null {
  let cur = date;
  for (let i = 0; i < n; i++) {
    const prev = previousSession(calendar, cur);
    if (prev === null) return null;
    cur = prev;
  }
  return cur;
}

export function tradingDaysBetween(calendar: SessionCalendar, a: string, b: string): number {
  return calendar.tradingDates().filter((d) => d > a && d <= b).length;
}

// IST = UTC+5:30, fixed offset (India does not observe DST).
const IST_OFFSET_MINUTES = 5 * 60 + 30;
// NSE's cash session opens at 09:15 IST. A conservative floor before that --
// anything before 09:00 IST is treated as still belonging to the PREVIOUS
// calendar date's session. This is the fix for recurring-bugs.md's #1
// documented class: "Post-midnight jobs now finish after midnight IST, so
// 'today' resolves to a day with no grid row -> UPDATE matches 0 rows,
// silently." logicalSession() is deliberately pure time-of-day math with no
// calendar dependency, so it works even before Stage 2 populates
// trading_session at all.
const SESSION_OPEN_FLOOR_MINUTES = 9 * 60;

export function logicalSession(now: Date): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  const minutesOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  if (minutesOfDay < SESSION_OPEN_FLOOR_MINUTES) {
    shifted.setUTCDate(shifted.getUTCDate() - 1);
  }
  const iso = shifted.toISOString();
  return iso.slice(0, 10);
}

export interface ScheduleTarget {
  /** IST hour, 0-23. */
  hour: number;
  /** IST minute, 0-59. */
  minute: number;
  /** IST-local day-of-week (0=Sun..6=Sat) this job is meant to fire on. Omit for "every day". */
  daysOfWeek?: readonly number[];
}

/**
 * True when `now` falls within `toleranceMinutes` of a one-shot cron job's intended IST
 * fire time (and day-of-week, if given).
 *
 * PM2's `cron_restart` launches an app IMMEDIATELY on `pm2 start`/registration/restart,
 * regardless of the cron field -- confirmed live 2026-09-03: an ecosystem-wide pm2 restart
 * at 09:20 IST (5 min after market open) fired all 11 greenfield night/weekend-only jobs plus
 * pg-backup-nightly at once. For gf-bhavcopy-daily this wasn't just wasted work: NSE's bhavcopy
 * URL 404s before ~18:00 IST, and that response is checkpointed as `status='skipped',
 * skip_reason='non-trading day (404)'` -- indistinguishable from a real holiday to
 * isRunAlreadyCompleted(), which then silently no-ops the REAL 19:30 IST run for the rest of
 * the day. See recurring-bugs.md's "Registered != running, for a pm2 cron_restart job" entry --
 * this is the same root cause producing data corruption instead of dormancy.
 *
 * Callers should check this FIRST, before opening any ingestion_run / doing any real work, and
 * exit without writing a checkpoint on a miss -- an off-schedule launch must leave no trace for
 * the real fire to trip over, the same way a skip must never stamp over a real run's status.
 *
 * Default tolerance is 4 min, not generous: pm2's croner fires a `cron_restart` app at the exact
 * scheduled minute (this guard runs before any DB/network work, so process-start jitter is at
 * most a few seconds), and the evening chain's own jobs sit as close as 10 min apart
 * (21:30/21:40/21:50/22:00 IST in ecosystem.config.cjs). A wider tolerance would make adjacent
 * jobs' acceptance windows overlap, so a single off-schedule pm2 restart landing anywhere in
 * that corridor could pass the guard for several jobs at once and fire them out of their
 * intended order -- a smaller-scale repeat of the exact failure mode this guard exists to close.
 * 4 min keeps every pairwise window non-overlapping WITH a real gap left over (2*4=8 < 10, the
 * tightest real spacing) -- a restart landing in that dead zone is correctly rejected by every
 * job, the safest possible outcome -- while still covering any plausible process-start jitter.
 */
export function isWithinScheduleWindow(
  now: Date,
  target: ScheduleTarget,
  toleranceMinutes = 4,
): boolean {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  if (target.daysOfWeek && !target.daysOfWeek.includes(shifted.getUTCDay())) {
    return false;
  }
  const minutesOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const targetMinutes = target.hour * 60 + target.minute;
  const diff = Math.abs(minutesOfDay - targetMinutes);
  return Math.min(diff, 1440 - diff) <= toleranceMinutes;
}
