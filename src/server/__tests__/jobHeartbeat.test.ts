import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRows: any[] = [];
vi.mock('../dbAsync', () => ({
  dbAll: vi.fn(async () => mockRows),
  dbRun: vi.fn(async () => {}),
  dbExec: vi.fn(async () => {}),
}));
vi.mock('../jobRegistry', () => ({
  JOB_REGISTRY: [
    { jobName: 'daily-job', label: 'Daily Job', cronPattern: '0 10 * * 1-5', graceMinutes: 60, critical: true },
    { jobName: 'event-job', label: 'Event Job', graceMinutes: 0, critical: false },
    // Mirrors intraday-fetcher/live-screener-collect: cron fires through 10:45 UTC as a
    // post-close safety margin, but the job's real work window (via isMarketOpen()) closes at
    // 10:00 UTC. cronPattern is deliberately identical to 'stale-tail-job' below (same
    // generous-tail shape) so the two tests are a true before/after pair, not different setups.
    { jobName: 'market-hours-job', label: 'Market Hours Job', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false,
      lateDeadlineCronPatterns: ['45 3 * * 1-5', '*/15 4-9 * * 1-5', '0 10 * * 1-5'] },
    { jobName: 'stale-tail-job', label: 'Stale Tail Job', cronPattern: '*/15 3-10 * * 1-5', graceMinutes: 45, critical: false },
  ],
}));
vi.mock('../monitorScripts', () => ({ MONITOR_SCRIPTS: [] }));
vi.mock('../dataQualityChecks', async () => {
  // Real tradingDaysStale() is a pure function with no DB import-time side effects (see its
  // module's header) -- use the actual implementation so the weekend-aware tests below exercise
  // real behavior instead of a hand-copied reimplementation that can't disagree with the code
  // it's meant to be checking.
  const actual = await vi.importActual<typeof import('../dataQualityChecks')>('../dataQualityChecks');
  return {
    DATA_QUALITY_CHECKS: [{ id: 'ohlcv-freshness-coverage' }],
    tradingDaysStale: actual.tradingDaysStale,
  };
});

import { getLateJobs, getStaleJobs, bullJobDurationMs } from '../jobHeartbeat';

describe('getLateJobs', () => {
  beforeEach(() => { mockRows.length = 0; });

  it('flags a job whose last success predates today\'s expected fire time plus grace', async () => {
    // 'daily-job' fires 10:00 UTC weekdays; "now" is Thu 2026-07-02T12:00:00Z (2h after fire+60min grace)
    const now = new Date('2026-07-02T12:00:00Z');
    mockRows.push({ job_name: 'daily-job', last_success_at: new Date('2026-07-01T10:05:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).toContain('daily-job');
  });

  it('does not flag a job that already succeeded after today\'s fire time', async () => {
    const now = new Date('2026-07-02T12:00:00Z');
    mockRows.push({ job_name: 'daily-job', last_success_at: new Date('2026-07-02T10:02:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).not.toContain('daily-job');
  });

  it('does not flag before the grace period has elapsed', async () => {
    // fire time 10:00 UTC, grace 60 min -> not late until 11:00 UTC
    const now = new Date('2026-07-02T10:30:00Z');
    mockRows.push({ job_name: 'daily-job', last_success_at: new Date('2026-07-01T10:05:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).not.toContain('daily-job');
  });

  it('skips event-driven jobs entirely', async () => {
    const now = new Date('2026-07-02T12:00:00Z');
    mockRows.push({ job_name: 'event-job', last_success_at: null, last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).not.toContain('event-job');
  });

  // 2026-08-13: intraday-fetcher/live-screener-collect were "newly late" in the daily digest
  // every single trading day, deterministically, despite running fine -- see jobRegistry.ts's
  // lateDeadlineCronPatterns doc comment. This pair is the negative control: same last-success
  // time, same "now" (18:45 UTC digest run), only the presence of lateDeadlineCronPatterns
  // differs -- proving the fix actually changes the verdict, not just that the new code path
  // doesn't crash.
  it('does not flag a market-hours job whose last success was at real market close, even at digest time', async () => {
    const now = new Date('2026-08-12T18:45:00Z'); // digest run time
    mockRows.push({ job_name: 'market-hours-job', last_success_at: new Date('2026-08-12T10:02:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).not.toContain('market-hours-job');
  });

  it('flags the same last-success/now pair as late without lateDeadlineCronPatterns (proves the fix matters)', async () => {
    const now = new Date('2026-08-12T18:45:00Z');
    mockRows.push({ job_name: 'stale-tail-job', last_success_at: new Date('2026-08-12T10:02:00Z').getTime(), last_error: null, last_alert_sent_at: null });
    const late = await getLateJobs(now);
    expect(late.map(l => l.job)).toContain('stale-tail-job');
  });
});

describe('getStaleJobs', () => {
  beforeEach(() => { mockRows.length = 0; });

  it('does not flag a data-quality check id even with last_success_at null', async () => {
    // markAlerted() inserts a job_heartbeat row keyed by DQ check id to dedupe Telegram
    // alerts; recordHeartbeat() is never called for these ids so last_success_at stays
    // NULL forever. Without the dataQualityIds exclusion this false-positives as
    // "has never succeeded" permanently, even after the check itself starts passing.
    mockRows.push({ job_name: 'ohlcv-freshness-coverage', last_success_at: null, last_error: null, last_alert_sent_at: 1234 });
    const stale = await getStaleJobs();
    expect(stale.map(s => s.job)).not.toContain('ohlcv-freshness-coverage');
  });

  it('still flags an unknown job with last_success_at null', async () => {
    mockRows.push({ job_name: 'some-untracked-job', last_success_at: null, last_error: null, last_alert_sent_at: null });
    const stale = await getStaleJobs();
    expect(stale.map(s => s.job)).toContain('some-untracked-job');
  });

  // 2026-08-30: 'deploy-drift'/'port-drift' pm2 apps were deliberately removed (`b27e588`,
  // 2026-08-27) and their DATA_QUALITY_CHECKS entries removed after them (AF-20260829-17,
  // 2026-08-29) since a checker for a job that will never run again is structurally guaranteed
  // to fail. That second fix silently dropped these two out of `dataQualityIds` too, so their
  // pre-existing job_heartbeat rows (never deleted) fell through into the generic 26h-staleness
  // branch and started logging a fresh "STALE" warning every hour for monitoring this session
  // intentionally turned off. Negative control: this test fails against jobHeartbeat.ts as it
  // stood right after AF-20260829-17, before the explicit `decommissionedJobs` exclusion.
  it('does not flag deploy-drift/port-drift as stale even though nothing will ever heartbeat them again', async () => {
    mockRows.push({ job_name: 'deploy-drift', last_success_at: Date.now() - 48 * 3_600_000, last_error: null, last_alert_sent_at: null });
    mockRows.push({ job_name: 'port-drift', last_success_at: null, last_error: null, last_alert_sent_at: null });
    const stale = await getStaleJobs();
    expect(stale.map(s => s.job)).not.toContain('deploy-drift');
    expect(stale.map(s => s.job)).not.toContain('port-drift');
  });

  // 2026-08-30: ml-daily-ops's T.run() sub-steps (event-triggers, online-learner,
  // breakout-classifier-train, ...) write their own job_heartbeat row, are Mon-Fri-only, and
  // are NOT in JOB_REGISTRY (only their parent 'ml-daily-ops' is) -- so they fell through into
  // this flat 26h calendar check and logged "STALE" every single weekend, live-confirmed
  // 2026-08-30 (a Sunday) against a Friday success. Negative control: fails against the plain
  // `now - last_success_at > DEFAULT_STALE_MS` comparison before the tradingDaysStale() fix.
  it('does not flag a Mon-Fri-only step as stale on a weekend read of its Friday success', async () => {
    const now = new Date('2026-08-30T07:00:00Z'); // Sunday
    const fridaySuccess = new Date('2026-08-28T15:09:25Z').getTime(); // Friday
    vi.setSystemTime(now);
    mockRows.push({ job_name: 'event-triggers', last_success_at: fridaySuccess, last_error: null, last_alert_sent_at: null });
    const stale = await getStaleJobs();
    vi.useRealTimers();
    expect(stale.map(s => s.job)).not.toContain('event-triggers');
  });

  it('still flags a step whose last success predates the weekend by a genuine multi-day gap', async () => {
    const now = new Date('2026-08-30T07:00:00Z'); // Sunday
    const staleSuccess = new Date('2026-08-24T15:09:25Z').getTime(); // the Monday before -- a real week-long gap
    vi.setSystemTime(now);
    mockRows.push({ job_name: 'event-triggers', last_success_at: staleSuccess, last_error: null, last_alert_sent_at: null });
    const stale = await getStaleJobs();
    vi.useRealTimers();
    expect(stale.map(s => s.job)).toContain('event-triggers');
  });
});

/**
 * duration_ms landed 2026-09-04 but was populated on only 21 of 432 job_run_history rows (4.9%)
 * measured 2026-09-05 -- recordHeartbeat is the write chokepoint, but it has no way to derive a
 * duration itself, and the ~44 hand-wired worker handlers in queues.ts all called it without one.
 * The job object those handlers already receive carries BullMQ's own processedOn/finishedOn, so
 * the duration is available at every call site without threading a timer through anything.
 *
 * The undefined-job case is not hypothetical: BullMQ passes `undefined` to an 'failed' handler
 * when the job could not be loaded, so a helper that assumes a job would throw inside an error
 * handler -- turning a recorded failure into a lost one.
 */
describe('bullJobDurationMs', () => {
  it('returns the processing duration when BullMQ recorded both timestamps', () => {
    expect(bullJobDurationMs({ processedOn: 1_000, finishedOn: 4_500 } as any)).toBe(3_500);
  });

  it('returns undefined for a job BullMQ never loaded, rather than throwing in a failed handler', () => {
    expect(bullJobDurationMs(undefined)).toBeUndefined();
    expect(bullJobDurationMs(null as any)).toBeUndefined();
  });

  it('returns undefined when either timestamp is missing', () => {
    expect(bullJobDurationMs({ processedOn: 1_000 } as any)).toBeUndefined();
    expect(bullJobDurationMs({ finishedOn: 4_500 } as any)).toBeUndefined();
  });

  it('returns undefined rather than a negative duration if the clocks disagree', () => {
    expect(bullJobDurationMs({ processedOn: 9_000, finishedOn: 1_000 } as any)).toBeUndefined();
  });

  it('counts a sub-millisecond job as 0, not as missing', () => {
    // 0 is a real measurement; coercing it to undefined would silently drop the fastest jobs
    // from every duration statistic, which is exactly the population most likely to be a no-op.
    expect(bullJobDurationMs({ processedOn: 5_000, finishedOn: 5_000 } as any)).toBe(0);
  });
});
