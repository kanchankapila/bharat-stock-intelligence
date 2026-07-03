import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock() calls are hoisted above all other statements, so any variable referenced
// inside a factory must itself be created via vi.hoisted() (or be "mock"-prefixed and
// still hit ordering edge cases with multiple mocks) — see https://vitest.dev/api/vi.html#vi-hoisted
const { mockSend, mockGetLateJobs, mockWasAlreadyAlerted, mockMarkAlerted, mockGetSystemStatus } = vi.hoisted(() => ({
  mockSend: vi.fn(async (_text: string) => true),
  mockGetLateJobs: vi.fn(),
  mockWasAlreadyAlerted: vi.fn(),
  mockMarkAlerted: vi.fn(),
  mockGetSystemStatus: vi.fn(async () => []),
}));

vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: mockSend },
}));

vi.mock('../jobHeartbeat', () => ({
  getLateJobs: mockGetLateJobs,
  wasAlreadyAlerted: mockWasAlreadyAlerted,
  markAlerted: mockMarkAlerted,
}));

vi.mock('../jobRegistry', () => ({
  JOB_REGISTRY: [
    { jobName: 'critical-job', label: 'Critical Job', cronPattern: '0 10 * * 1-5', graceMinutes: 45, critical: true },
    { jobName: 'noncritical-job', label: 'Noncritical Job', cronPattern: '0 11 * * 1-5', graceMinutes: 45, critical: false },
  ],
}));

vi.mock('../routers/monitor.router', () => ({
  getSystemStatus: mockGetSystemStatus,
  MONITOR_SCRIPTS: [],
}));

import { checkAndAlertLateJobs, buildDailyDigest } from '../jobWatchdog';

describe('checkAndAlertLateJobs', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockMarkAlerted.mockClear();
    mockWasAlreadyAlerted.mockReset().mockResolvedValue(false);
  });

  it('sends one Telegram alert for a late critical job not yet alerted', async () => {
    mockGetLateJobs.mockResolvedValue([
      { job: 'critical-job', label: 'Critical Job', expectedAt: new Date('2026-07-02T10:00:00Z'), hoursLate: 2, lastError: null },
    ]);
    await checkAndAlertLateJobs(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toContain('Critical Job');
    expect(mockMarkAlerted).toHaveBeenCalledWith('critical-job', new Date('2026-07-02T10:00:00Z').getTime());
  });

  it('does not re-alert if wasAlreadyAlerted returns true for this occurrence', async () => {
    mockGetLateJobs.mockResolvedValue([
      { job: 'critical-job', label: 'Critical Job', expectedAt: new Date('2026-07-02T10:00:00Z'), hoursLate: 2, lastError: null },
    ]);
    mockWasAlreadyAlerted.mockResolvedValue(true);
    await checkAndAlertLateJobs(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not alert for a late but non-critical job', async () => {
    mockGetLateJobs.mockResolvedValue([
      { job: 'noncritical-job', label: 'Noncritical Job', expectedAt: new Date('2026-07-02T11:00:00Z'), hoursLate: 1, lastError: null },
    ]);
    await checkAndAlertLateJobs(new Date('2026-07-02T13:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('buildDailyDigest', () => {
  it('includes every registry job and every MONITOR_SCRIPTS entry', async () => {
    mockGetLateJobs.mockResolvedValue([]);
    mockGetSystemStatus.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'success', lastRunAt: '2026-07-02T09:00:00Z', critical: true },
    ]);
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Critical Job');
    expect(digest).toContain('Noncritical Job');
    expect(digest).toContain('Technical Signal Scan');
  });
});
