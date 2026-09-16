import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  hasOccurrenceOnIstDate,
  isJobSupposedToRunOnDate,
  getJobTypicalDurations,
  getLateJobs,
  __resetJobTypicalDurationsCache,
  __resetTradingSessionCache,
  type TradingSessionWindow,
} from '../jobHeartbeat';

const mockDbAll = vi.fn();
vi.mock('../dbAsync', () => ({
  dbAll: (sql: string, params?: unknown[]) => mockDbAll(sql, params),
  dbRun: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
  dbExec: vi.fn(async () => {}),
}));

const mockIsTradingHolidayToday = vi.fn(async () => false);
vi.mock('../marketStatusService', () => ({
  isTradingHolidayToday: () => mockIsTradingHolidayToday(),
}));

vi.mock('../jobRegistry', () => ({
  JOB_REGISTRY: [
    { jobName: 'fast-job', label: 'Fast Job', cronPattern: '0 10 * * 1-5', graceMinutes: 60, critical: true },
    { jobName: 'slow-job', label: 'Slow Job', cronPattern: '0 10 * * 1-5', graceMinutes: 180, critical: true },
    { jobName: 'saturday-job', label: 'Saturday Job', cronPattern: '0 2 * * 6', graceMinutes: 120, critical: false },
    { jobName: 'closed-day-early-batch', label: 'Closed Day Early Batch', cronPattern: '40 1 * * 1-5', graceMinutes: 60, critical: false },
    { jobName: 'news-sentiment', label: 'News Sentiment', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: true },
    { jobName: 'trendlyne-intraday', label: 'Trendlyne Intraday', everyMs: 15 * 60 * 1000, graceMinutes: 45, critical: false,
      lateDeadlineCronPatterns: ['45 3 * * 1-5', '0 10 * * 1-5'] },
  ],
  HOLIDAY_ACTIVE_JOB_NAMES: new Set(['closed-day-early-batch']),
}));

vi.mock('../monitorScripts', () => ({ MONITOR_SCRIPTS: [] }));
vi.mock('../dataQualityChecks', () => ({ DATA_QUALITY_CHECKS: [] }));

describe('hasOccurrenceOnIstDate', () => {
  it('identifies occurrences accurately across IST calendar days', () => {
    // Saturday job: 02:00 UTC = 07:30 IST Saturday
    expect(hasOccurrenceOnIstDate('0 2 * * 6', '2026-09-12')).toBe(true);  // Saturday
    expect(hasOccurrenceOnIstDate('0 2 * * 6', '2026-09-14')).toBe(false); // Monday

    // Weekday job: 15:00 UTC = 20:30 IST Mon-Fri
    expect(hasOccurrenceOnIstDate('0 15 * * 1-5', '2026-09-14')).toBe(true);  // Monday
    expect(hasOccurrenceOnIstDate('0 15 * * 1-5', '2026-09-15')).toBe(true);  // Tuesday
    expect(hasOccurrenceOnIstDate('0 15 * * 1-5', '2026-09-12')).toBe(false); // Saturday
    expect(hasOccurrenceOnIstDate('0 15 * * 1-5', '2026-09-13')).toBe(false); // Sunday

    // Friday-night job: 18:00 UTC = 23:30 IST Friday
    expect(hasOccurrenceOnIstDate('0 18 * * 5', '2026-09-11')).toBe(true);  // Friday
    expect(hasOccurrenceOnIstDate('0 18 * * 5', '2026-09-12')).toBe(false); // Saturday

    // Daily job: runs every day
    expect(hasOccurrenceOnIstDate('20 17 * * *', '2026-09-14')).toBe(true);
    expect(hasOccurrenceOnIstDate('20 17 * * *', '2026-09-12')).toBe(true);
  });
});

describe('isJobSupposedToRunOnDate', () => {
  const normalMonday = new Date('2026-09-14T12:00:00+05:30');
  const normalSaturday = new Date('2026-09-12T12:00:00+05:30');
  const normalSunday = new Date('2026-09-13T12:00:00+05:30');
  const holidayMonday = new Date('2026-09-14T12:00:00+05:30');

  it('correctly filters jobs on a normal trading weekday', () => {
    expect(isJobSupposedToRunOnDate({ jobName: 'fast-job', cronPattern: '0 10 * * 1-5' }, normalMonday, false)).toBe(true);
    expect(isJobSupposedToRunOnDate({ jobName: 'saturday-job', cronPattern: '0 2 * * 6' }, normalMonday, false)).toBe(false);
    expect(isJobSupposedToRunOnDate({ jobName: 'news-sentiment', everyMs: 900000 }, normalMonday, false)).toBe(true);
    expect(isJobSupposedToRunOnDate({
      jobName: 'trendlyne-intraday', everyMs: 900000, lateDeadlineCronPatterns: ['45 3 * * 1-5']
    }, normalMonday, false)).toBe(true);
  });

  it('correctly filters jobs on a weekend', () => {
    // Saturday
    expect(isJobSupposedToRunOnDate({ jobName: 'fast-job', cronPattern: '0 10 * * 1-5' }, normalSaturday, false)).toBe(false);
    expect(isJobSupposedToRunOnDate({ jobName: 'saturday-job', cronPattern: '0 2 * * 6' }, normalSaturday, false)).toBe(true);
    expect(isJobSupposedToRunOnDate({ jobName: 'news-sentiment', everyMs: 900000 }, normalSaturday, false)).toBe(true);
    // Intraday market-hours skips on Saturday
    expect(isJobSupposedToRunOnDate({
      jobName: 'trendlyne-intraday', everyMs: 900000, lateDeadlineCronPatterns: ['45 3 * * 1-5']
    }, normalSaturday, false)).toBe(false);

    // Sunday
    expect(isJobSupposedToRunOnDate({ jobName: 'saturday-job', cronPattern: '0 2 * * 6' }, normalSunday, false)).toBe(false);
    expect(isJobSupposedToRunOnDate({ jobName: 'fast-job', cronPattern: '0 10 * * 1-5' }, normalSunday, false)).toBe(false);
    expect(isJobSupposedToRunOnDate({ jobName: 'news-sentiment', everyMs: 900000 }, normalSunday, false)).toBe(true);
  });

  it('correctly filters jobs on an NSE trading holiday', () => {
    // Weekday-only regular jobs skip on trading holiday
    expect(isJobSupposedToRunOnDate({ jobName: 'fast-job', cronPattern: '0 10 * * 1-5' }, holidayMonday, true)).toBe(false);
    // Saturday weekly jobs do not run on Monday holiday
    expect(isJobSupposedToRunOnDate({ jobName: 'saturday-job', cronPattern: '0 2 * * 6' }, holidayMonday, true)).toBe(false);
    // closed-day-early-batch is holiday-active
    expect(isJobSupposedToRunOnDate({ jobName: 'closed-day-early-batch', cronPattern: '40 1 * * 1-5' }, holidayMonday, true)).toBe(true);
    // 24/7 jobs run on holidays
    expect(isJobSupposedToRunOnDate({ jobName: 'news-sentiment', everyMs: 900000 }, holidayMonday, true)).toBe(true);
    // Market-hours intraday skips on holidays
    expect(isJobSupposedToRunOnDate({
      jobName: 'trendlyne-intraday', everyMs: 900000, lateDeadlineCronPatterns: ['45 3 * * 1-5']
    }, holidayMonday, true)).toBe(false);
  });
});

describe('getLateJobs with typical duration and day-scoped scheduling', () => {
  beforeEach(() => {
    __resetTradingSessionCache();
    __resetJobTypicalDurationsCache();
    mockDbAll.mockReset();
    mockIsTradingHolidayToday.mockReset().mockResolvedValue(false);
  });

  it('does NOT report Saturday jobs as late on a Monday', async () => {
    mockDbAll.mockImplementation(async (sql: string) => {
      if (sql.includes('stock_ohlcv')) {
        return [{ d: '2026-09-11' }, { d: '2026-09-10' }];
      }
      if (sql.includes('job_heartbeat')) {
        // Saturday job failed on Saturday 09-12 and has old last_success_at
        return [
          { job_name: 'saturday-job', last_success_at: new Date('2026-09-05T02:00:00Z').getTime(), last_error: 'err' },
          { job_name: 'fast-job', last_success_at: new Date('2026-09-14T10:01:00Z').getTime(), last_error: null },
        ];
      }
      if (sql.includes('job_run_history')) {
        return [];
      }
      return [];
    });

    // Evaluated on Monday at 12:00 UTC
    const late = await getLateJobs(new Date('2026-09-14T12:00:00Z'));
    // Saturday job should NOT be in late list because it wasn't supposed to run on Monday
    expect(late.map(l => l.job)).not.toContain('saturday-job');
  });

  it('evaluates delays based on typical duration rather than static grace when duration history exists', async () => {
    mockDbAll.mockImplementation(async (sql: string) => {
      if (sql.includes('stock_ohlcv')) {
        return [{ d: '2026-09-14' }, { d: '2026-09-11' }];
      }
      if (sql.includes('job_heartbeat')) {
        // Both fast-job and slow-job scheduled at 10:00 UTC. Neither has succeeded today yet.
        return [
          { job_name: 'fast-job', last_success_at: new Date('2026-09-11T10:00:00Z').getTime(), last_error: null },
          { job_name: 'slow-job', last_success_at: new Date('2026-09-11T10:00:00Z').getTime(), last_error: null },
        ];
      }
      if (sql.includes('job_run_history')) {
        // fast-job usually takes 2 minutes (120,000ms), buffer is 10 min -> deadline ~10:12 UTC
        // slow-job usually takes 60 minutes (3,600,000ms), buffer is 30 min -> deadline ~11:30 UTC
        return [
          { job_name: 'fast-job', avg_ms: 120000, p95_ms: 120000, count: 10 },
          { job_name: 'slow-job', avg_ms: 3600000, p95_ms: 3600000, count: 10 },
        ];
      }
      return [];
    });

    // Check at 10:20 UTC (20 minutes after 10:00 UTC fire time):
    // fast-job deadline was 10:12 UTC -> past deadline, so it IS delayed!
    // slow-job deadline is 11:30 UTC -> still within usual duration, so it is NOT delayed!
    const lateAt1020 = await getLateJobs(new Date('2026-09-14T10:20:00Z'));
    expect(lateAt1020.map(l => l.job)).toContain('fast-job');
    expect(lateAt1020.map(l => l.job)).not.toContain('slow-job');

    // Check at 11:45 UTC (105 minutes after 10:00 UTC fire time):
    // Both deadlines have passed -> now both are delayed
    __resetJobTypicalDurationsCache();
    const lateAt1145 = await getLateJobs(new Date('2026-09-14T11:45:00Z'));
    expect(lateAt1145.map(l => l.job)).toContain('fast-job');
    expect(lateAt1145.map(l => l.job)).toContain('slow-job');
  });

  it('does NOT report a job as late on an NSE trading holiday if it was planned to skip', async () => {
    mockIsTradingHolidayToday.mockResolvedValue(true);
    const holidayDate = new Date('2026-09-16T12:00:00Z'); // Wednesday holiday
    mockDbAll.mockImplementation(async (sql: string) => {
      if (sql.includes('stock_ohlcv')) {
        // 2026-09-16 is absent from session dates
        return [{ d: '2026-09-15' }, { d: '2026-09-14' }];
      }
      if (sql.includes('technical_signals')) {
        // Gap probe: no rows on the holiday
        return [];
      }
      if (sql.includes('job_heartbeat')) {
        return [
          { job_name: 'fast-job', last_success_at: new Date('2026-09-15T10:00:00Z').getTime(), last_error: null },
          { job_name: 'closed-day-early-batch', last_success_at: new Date('2026-09-15T01:40:00Z').getTime(), last_error: null },
        ];
      }
      return [];
    });

    const late = await getLateJobs(holidayDate);
    // fast-job planned to skip -> not late
    expect(late.map(l => l.job)).not.toContain('fast-job');
  });
});
