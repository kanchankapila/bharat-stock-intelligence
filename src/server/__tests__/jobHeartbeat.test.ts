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
  ],
}));

import { getLateJobs } from '../jobHeartbeat';

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
});
