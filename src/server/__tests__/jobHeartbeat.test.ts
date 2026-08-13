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
vi.mock('../dataQualityChecks', () => ({
  DATA_QUALITY_CHECKS: [{ id: 'ohlcv-freshness-coverage' }],
}));

import { getLateJobs, getStaleJobs } from '../jobHeartbeat';

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
});
