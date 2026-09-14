import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pins the 2026-09-14 holiday-awareness fix for the lateness layer (jobHeartbeat.ts +
 * monitor.router.ts, both feeding the Telegram digest and the 15-min watchdog).
 *
 * The mechanical chain being fixed: on an NSE trading holiday every weekday-only job in
 * the holiday-skip family returns { skipped: true }, and registerJob.ts's completed
 * handler deliberately declines to stamp a heartbeat for a skip ("a skip is not a
 * success"). The lateness math then saw "no success since the last expected fire time"
 * and the digest reported the whole family "⚠️ ~Xh late" on exactly the days they were
 * correctly idle — the phantom-delay class the user reported. HOLIDAY_SKIP_NOTE at the
 * foot of confluence.jobs.ts documents this prerequisite ("make getLateJobs()
 * holiday-aware, THEN convert all of these together").
 *
 * The fix judges the occurrence's IST calendar date against the exchange's own session
 * record (distinct recent stock_ohlcv dates — the same source as_of.py's
 * trading_days_back() trusts). Two hard rules the tests below pin:
 *  - Forgiveness applies ONLY to weekday-only patterns. A weekend-anchored weekly job
 *    ('0 2 * * 6' — nse-sync) or a 24/7 cadence (trendlyne-catchup's every-20-min cron)
 *    has occurrences on days stock_ohlcv legitimately never holds, so a blanket
 *    "date not in the session table = holiday" would pardon a genuinely missed run
 *    forever.
 *  - Fail-open: no session window (empty table, stale newest session > 6 days, DB
 *    error) keeps the pre-fix behavior, so a stalled EOD pipeline still alerts.
 */

const mockHeartbeatRows: any[] = [];
let mockSessionRows: any[] = [];      // stock_ohlcv rows (session dates)
let mockScanRows: any[] = [];         // technical_signals rows (gap-band probe)
const mockIsTradingHolidayToday = vi.fn(async () => false);
vi.mock('../dbAsync', () => ({
  dbAll: vi.fn(async (sql: string) =>
    sql.includes('stock_ohlcv') ? mockSessionRows
      : sql.includes('technical_signals') ? mockScanRows
        : mockHeartbeatRows),
  dbRun: vi.fn(async () => {}),
  dbExec: vi.fn(async () => {}),
}));
// The live BSE holiday feed: exact for TODAY only. Default not-a-holiday (fail-open).
vi.mock('../marketStatusService', () => ({
  isTradingHolidayToday: (...args: unknown[]) => mockIsTradingHolidayToday(...(args as [])),
}));
vi.mock('../jobRegistry', () => ({
  JOB_REGISTRY: [
    { jobName: 'daily-job', label: 'Daily Job', cronPattern: '0 10 * * 1-5', graceMinutes: 60, critical: true },
    // Same '0 2 * * 6' shape as nse-sync/fundamentals-sync/ml-weekly-retrain: a Saturday
    // weekly. Its occurrences fall on days the session table never holds.
    { jobName: 'saturday-job', label: 'Saturday Job', cronPattern: '0 2 * * 6', graceMinutes: 120, critical: true },
    // closed-day-early-batch's shape: a weekday-only cron that deliberately RUNS on holidays
    // (the holiday dispatcher) — forgiveness must never reach it.
    { jobName: 'holiday-active-job', label: 'Holiday Active Job', cronPattern: '40 1 * * 1-5', graceMinutes: 60, critical: true },
  ],
  HOLIDAY_ACTIVE_JOB_NAMES: new Set(['holiday-active-job']),
}));
vi.mock('../monitorScripts', () => ({ MONITOR_SCRIPTS: [] }));
vi.mock('../dataQualityChecks', async () => {
  const actual = await vi.importActual<typeof import('../dataQualityChecks')>('../dataQualityChecks');
  return { DATA_QUALITY_CHECKS: [], tradingDaysStale: actual.tradingDaysStale };
});

import {
  getLateJobs,
  computeCronLateness,
  patternsAreWeekdayOnly,
  isDeliberatelyIdleOccurrence,
  __resetTradingSessionCache,
  type TradingSessionWindow,
} from '../jobHeartbeat';

/** Sessions 2026-09-01..15 with 2026-09-16 (Wednesday) a trading holiday. Newest session
 *  is the 15th, so at any check time on the 16th or 17th the 6-day freshness guard passes. */
const SESSIONS_WITH_WEDNESDAY_HOLIDAY = [
  '2026-09-15', '2026-09-14', '2026-09-11', '2026-09-10', '2026-09-09',
  '2026-09-08', '2026-09-07', '2026-09-04', '2026-09-03', '2026-09-02',
];

function seedSessions(dates: string[]): void {
  mockSessionRows = dates.map(d => ({ d }));
}

/** Hand-built window for the sync unit tests. `holidays` are the dates the loader would
 *  have proven idle (session gap inside the window, probe-confirmed gap, or feed-confirmed
 *  today); everything else mirrors the real window's fields. */
function makeWindow(holidays: string[] = []): TradingSessionWindow {
  const sorted = [...SESSIONS_WITH_WEDNESDAY_HOLIDAY].sort();
  return {
    oldest: sorted[0],
    newest: sorted[sorted.length - 1],
    dates: new Set(SESSIONS_WITH_WEDNESDAY_HOLIDAY),
    idleDates: new Set(holidays),
  };
}

describe('patternsAreWeekdayOnly', () => {
  it('accepts every weekday-restricted shape in the registries', () => {
    expect(patternsAreWeekdayOnly(['0 10 * * 1-5'])).toBe(true);
    expect(patternsAreWeekdayOnly(['*/15 4-9 * * 1-5'])).toBe(true);
    expect(patternsAreWeekdayOnly(['0 4 * * 1-5', '20 13 * * 1-5'])).toBe(true); // multi-pattern
    expect(patternsAreWeekdayOnly(['0 17 * * 1-5'])).toBe(true);
  });

  it('rejects 24/7 and weekend-anchored schedules — the pardon must never reach them', () => {
    expect(patternsAreWeekdayOnly(['*/20 * * * *'])).toBe(false);      // trendlyne-catchup
    expect(patternsAreWeekdayOnly(['20 17 * * *'])).toBe(false);       // job-digest (all 7 days)
    expect(patternsAreWeekdayOnly(['0 2 * * 6'])).toBe(false);         // nse-sync (Saturday)
    expect(patternsAreWeekdayOnly(['0 3 * * 6'])).toBe(false);         // fundamentals-sync
    expect(patternsAreWeekdayOnly(['0 5 * * 6'])).toBe(false);         // ml-weekly-retrain
    expect(patternsAreWeekdayOnly(['30 0 * * *', '0 2 * * *'])).toBe(false); // confluence-compute
    // A range that spills into the weekend is not weekday-only either.
    expect(patternsAreWeekdayOnly(['0 10 * * 1-6'])).toBe(false);
    expect(patternsAreWeekdayOnly(['0 10 * * 1,6'])).toBe(false);
  });
});

describe('isDeliberatelyIdleOccurrence', () => {
  // Wednesday 2026-09-16 proven idle (what the loader derives: the session gap was
  // confirmed by the technical_signals probe / today's live feed).
  const window = makeWindow(['2026-09-16']);

  it('says yes for a weekday the loader proved idle (the holiday)', () => {
    expect(isDeliberatelyIdleOccurrence(new Date('2026-09-16T10:00:00Z'), window)).toBe(true);
    // The NEXT morning's digest judges the holiday's evening occurrences too.
    expect(isDeliberatelyIdleOccurrence(new Date('2026-09-16T15:40:00Z'), window)).toBe(true);
  });

  it('says no for a real session date, a weekend, a null window, and unproven/old dates', () => {
    expect(isDeliberatelyIdleOccurrence(new Date('2026-09-15T10:00:00Z'), window)).toBe(false);
    expect(isDeliberatelyIdleOccurrence(new Date('2026-09-12T02:00:00Z'), window)).toBe(false); // Saturday
    expect(isDeliberatelyIdleOccurrence(new Date('2026-09-16T10:00:00Z'), null)).toBe(false);   // fail-open
    // A weekday the loader could NOT prove idle (e.g. the probe found technical_signals
    // rows: a real session whose EOD write is merely pending) is judged normally.
    expect(isDeliberatelyIdleOccurrence(new Date('2026-09-16T10:00:00Z'), makeWindow([]))).toBe(false);
    // Older than the window = unobserved, not a holiday.
    expect(isDeliberatelyIdleOccurrence(new Date('2026-08-20T10:00:00Z'), window)).toBe(false);
  });
});

describe('computeCronLateness holiday forgiveness', () => {
  const window = makeWindow(['2026-09-16']);

  it('forgives a weekday-only job whose last success predates a holiday fire', () => {
    // daily-job fired 10:00 UTC on the holiday (Wed 09-16); last success is Tuesday's run.
    // Checked 2h later, well past the 60-min grace — pre-fix this read "late".
    const { late } = computeCronLateness(
      ['0 10 * * 1-5'], 60,
      new Date('2026-09-15T10:05:00Z').getTime(),
      new Date('2026-09-16T12:00:00Z'),
      window,
    );
    expect(late).toBe(false);
  });

  it('still flags a genuinely missed run on a real session day', () => {
    // Same shape but now = Tuesday 09-15 (a real session): last success Monday's run is
    // BEFORE today's 10:00 UTC fire -> late. The holiday fix must not loosen this.
    const { late } = computeCronLateness(
      ['0 10 * * 1-5'], 60,
      new Date('2026-09-14T10:05:00Z').getTime(),
      new Date('2026-09-15T12:00:00Z'),
      window,
    );
    expect(late).toBe(true);
  });

  it('never forgives a weekend-anchored weekly job on its non-session Saturday', () => {
    // saturday-job fired Saturday 09-12 02:00 UTC (no session that day) and did not run;
    // last success the PREVIOUS Saturday. Checked Monday — still late.
    const { late } = computeCronLateness(
      ['0 2 * * 6'], 120,
      new Date('2026-09-05T02:05:00Z').getTime(),
      new Date('2026-09-14T12:00:00Z'),
      window,
    );
    expect(late).toBe(true);
  });

  it('never forgives a 24/7 pattern even on a holiday', () => {
    const { late } = computeCronLateness(
      ['30 0 * * *'], 45,
      new Date('2026-09-14T20:00:00Z').getTime(),
      new Date('2026-09-16T04:00:00Z'),
      window,
    );
    expect(late).toBe(true);
  });

  it('keeps the pre-fix behavior when the window is unavailable (fail-open)', () => {
    const { late } = computeCronLateness(
      ['0 10 * * 1-5'], 60,
      new Date('2026-09-15T10:05:00Z').getTime(),
      new Date('2026-09-16T12:00:00Z'),
      null,
    );
    expect(late).toBe(true);
  });

describe('getLateJobs holiday integration', () => {
  beforeEach(() => {
    __resetTradingSessionCache();
    mockHeartbeatRows.length = 0;
    mockSessionRows = [];
    mockScanRows = [];
    mockIsTradingHolidayToday.mockClear().mockResolvedValue(false);
  });

  it('does not report the skip family late on a trading holiday', async () => {
    seedSessions(SESSIONS_WITH_WEDNESDAY_HOLIDAY);
    // The holiday IS today: stock_ohlcv's EOD write cannot exist yet, so this case is
    // answered by the live feed (exactly what production does).
    mockIsTradingHolidayToday.mockResolvedValue(true);
    // daily-job's heartbeat: last success Tuesday's run (a skip on the holiday stamps nothing).
    mockHeartbeatRows.push({
      job_name: 'daily-job',
      last_success_at: new Date('2026-09-15T10:05:00Z').getTime(),
      last_error: null,
      last_alert_sent_at: null,
    });
    // Wednesday 09-16 12:00 UTC = 17:30 IST: fire (10:00 UTC) + grace (60m) both passed.
    const late = await getLateJobs(new Date('2026-09-16T12:00:00Z'));
    expect(late.map(l => l.job)).not.toContain('daily-job');
  });

  it('does not report the skip family late the MORNING AFTER a holiday (digest at 08:15 IST)', async () => {
    seedSessions(SESSIONS_WITH_WEDNESDAY_HOLIDAY);
    // Newest session is still Tuesday (Thursday's EOD write lands ~16:00 IST), so the
    // holiday sits in the ambiguous (newest, today) band — resolved by the probe: on a
    // holiday technical-scan wrote nothing, so no technical_signals rows exist for it.
    mockScanRows = []; // probe: no technical_signals row anywhere in the gap band
    mockHeartbeatRows.push({
      job_name: 'daily-job',
      last_success_at: new Date('2026-09-15T10:05:00Z').getTime(),
      last_error: null,
      last_alert_sent_at: null,
    });
    // Thursday 09-17 02:45 UTC: prev() is still the holiday's 10:00 UTC slot (Thursday's own
    // run is hours away) — the forgiveness must work without a post-holiday EOD write.
    const late = await getLateJobs(new Date('2026-09-17T02:45:00Z'));
    expect(late.map(l => l.job)).not.toContain('daily-job');
  });

  it('keeps judging a real session normally while its EOD write is pending', async () => {
    seedSessions(SESSIONS_WITH_WEDNESDAY_HOLIDAY);
    // Wednesday 09-16 is a REAL session: technical-scan wrote technical_signals this
    // morning (08:35 IST), but stock_ohlcv's EOD write (16:00 IST) has not landed and
    // the live feed says not-a-holiday — a genuinely missed run must STILL alert here,
    // or the same forgiveness would mask every real pre-16:00 failure.
    mockScanRows = [{ d: '2026-09-16' }];
    mockHeartbeatRows.push({
      job_name: 'daily-job',
      last_success_at: new Date('2026-09-15T10:05:00Z').getTime(),
      last_error: null,
      last_alert_sent_at: null,
    });
    const late = await getLateJobs(new Date('2026-09-16T12:00:00Z'));
    expect(late.map(l => l.job)).toContain('daily-job');
  });

  it('never forgives a job that deliberately RUNS on holidays (closed-day-early-batch polarity)', async () => {
    seedSessions(SESSIONS_WITH_WEDNESDAY_HOLIDAY);
    mockIsTradingHolidayToday.mockResolvedValue(true);
    // The dispatcher's last success is the previous day's 01:40 UTC slot; on the holiday it
    // FAILED to dispatch the critical early pipeline. It is NOT idle that day — the
    // HOLIDAY_ACTIVE_JOB_NAMES gate must keep it flagged late despite the holiday.
    mockHeartbeatRows.push({
      job_name: 'holiday-active-job',
      last_success_at: new Date('2026-09-15T01:45:00Z').getTime(),
      last_error: 'dispatch failed',
      last_alert_sent_at: null,
    });
    const late = await getLateJobs(new Date('2026-09-16T12:00:00Z'));
    expect(late.map(l => l.job)).toContain('holiday-active-job');
  });

  it('still reports a genuinely missed run on a normal day', async () => {
    seedSessions(SESSIONS_WITH_WEDNESDAY_HOLIDAY);
    mockHeartbeatRows.push({
      job_name: 'daily-job',
      last_success_at: new Date('2026-09-14T10:05:00Z').getTime(),
      last_error: null,
      last_alert_sent_at: null,
    });
    const late = await getLateJobs(new Date('2026-09-15T12:00:00Z')); // Tuesday, a real session
    expect(late.map(l => l.job)).toContain('daily-job');
  });

  it('fails open to "late" when the session window is stale (EOD writes stalled)', async () => {
    // Newest session 8 days before the check — past the 6-day freshness guard. A window this
    // old cannot distinguish a holiday from a stalled pipeline, so the lateness alert must
    // still fire (the pipeline being down is exactly what it exists to report).
    seedSessions([
      '2026-09-08', '2026-09-07', '2026-09-04', '2026-09-03', '2026-09-02',
      '2026-09-01', '2026-08-31', '2026-08-28', '2026-08-27', '2026-08-26',
    ]);
    mockHeartbeatRows.push({
      job_name: 'daily-job',
      last_success_at: new Date('2026-09-15T10:05:00Z').getTime(),
      last_error: null,
      last_alert_sent_at: null,
    });
    const late = await getLateJobs(new Date('2026-09-16T12:00:00Z'));
    expect(late.map(l => l.job)).toContain('daily-job');
  });

  it('fails open to "late" when the session table cannot be read', async () => {
    mockSessionRows = []; // empty table -> no window
    mockHeartbeatRows.push({
      job_name: 'daily-job',
      last_success_at: new Date('2026-09-15T10:05:00Z').getTime(),
      last_error: null,
      last_alert_sent_at: null,
    });
    const late = await getLateJobs(new Date('2026-09-16T12:00:00Z'));
    expect(late.map(l => l.job)).toContain('daily-job');
  });
});
});
