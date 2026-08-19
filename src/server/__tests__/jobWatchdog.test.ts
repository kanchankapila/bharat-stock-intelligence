import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock() calls are hoisted above all other statements, so any variable referenced
// inside a factory must itself be created via vi.hoisted() (or be "mock"-prefixed and
// still hit ordering edge cases with multiple mocks) — see https://vitest.dev/api/vi.html#vi-hoisted
const {
  mockSend, mockGetLateJobs, mockWasAlreadyAlerted, mockMarkAlerted, mockGetSystemStatus,
  mockDbGet, mockDbRun, mockDbAll, mockRunDataQualityChecks, mockGetLatestDataQualityResults,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockSend: vi.fn(async (_text: string) => true),
  mockGetLateJobs: vi.fn(),
  mockWasAlreadyAlerted: vi.fn(),
  mockMarkAlerted: vi.fn(),
  mockGetSystemStatus: vi.fn(async () => []),
  mockDbGet: vi.fn(async () => undefined),
  mockDbRun: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
  mockDbAll: vi.fn(async () => []),
  mockRunDataQualityChecks: vi.fn(async () => []),
  mockGetLatestDataQualityResults: vi.fn(async () => []),
  // Default: no log file on disk -- getRecentCatchupCounts treats that as "nothing to report",
  // not an error (see its try/catch). Individual tests override this to supply log content.
  mockReadFileSync: vi.fn((..._args: unknown[]): string => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));

vi.mock('fs', () => ({ default: { readFileSync: mockReadFileSync }, readFileSync: mockReadFileSync }));

vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: mockSend },
  sanitizeMarkdown: (text: string | null | undefined) =>
    (text || '').replace(/[_*`[\]]/g, ' ').replace(/\s+/g, ' ').trim(),
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

vi.mock('../dbAsync', () => ({
  dbGet: mockDbGet,
  dbRun: mockDbRun,
  dbAll: mockDbAll,
}));

vi.mock('../dataQualityChecks', () => ({
  runDataQualityChecks: mockRunDataQualityChecks,
  getLatestDataQualityResults: mockGetLatestDataQualityResults,
}));

import { checkAndAlertLateJobs, buildDailyDigest, checkAndAlertStaleScripts, checkAndAlertDataQuality } from '../jobWatchdog';

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

describe('checkAndAlertStaleScripts', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockMarkAlerted.mockClear();
    mockWasAlreadyAlerted.mockReset().mockResolvedValue(false);
  });

  it('sends one Telegram alert for a critical script in stale state not yet alerted today', async () => {
    mockGetSystemStatus.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'stale', lastRunAt: '2026-07-01T09:00:00Z', critical: true, error: null },
    ]);
    await checkAndAlertStaleScripts(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toContain('Technical Signal Scan');
    expect(mockMarkAlerted).toHaveBeenCalledWith('technical-scan', Date.UTC(2026, 6, 2));
  });

  it('sends one Telegram alert for a critical script in failed state', async () => {
    mockGetSystemStatus.mockResolvedValue([
      { id: 'fii-dii-fetcher', label: 'FII/DII Fetcher', runState: 'failed', lastRunAt: '2026-07-02T09:00:00Z', critical: true, error: 'boom' },
    ]);
    await checkAndAlertStaleScripts(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toContain('FII/DII Fetcher');
  });

  it('does not alert for a critical script in success/running/never state', async () => {
    mockGetSystemStatus.mockResolvedValue([
      { id: 'a', label: 'A', runState: 'success', lastRunAt: '2026-07-02T09:00:00Z', critical: true, error: null },
      { id: 'b', label: 'B', runState: 'running', lastRunAt: '2026-07-02T09:00:00Z', critical: true, error: null },
      { id: 'c', label: 'C', runState: 'never', lastRunAt: null, critical: true, error: null },
    ]);
    await checkAndAlertStaleScripts(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not alert for a non-critical script even if stale/failed', async () => {
    mockGetSystemStatus.mockResolvedValue([
      { id: 'noncrit', label: 'Noncrit', runState: 'stale', lastRunAt: '2026-07-01T09:00:00Z', critical: false, error: null },
    ]);
    await checkAndAlertStaleScripts(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not re-alert if wasAlreadyAlerted returns true for today', async () => {
    mockGetSystemStatus.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'stale', lastRunAt: '2026-07-01T09:00:00Z', critical: true, error: null },
    ]);
    mockWasAlreadyAlerted.mockResolvedValue(true);
    await checkAndAlertStaleScripts(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('checkAndAlertDataQuality', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockMarkAlerted.mockClear();
    mockWasAlreadyAlerted.mockReset().mockResolvedValue(false);
    mockRunDataQualityChecks.mockReset();
  });

  it('sends one Telegram alert for a critical check in fail state not yet alerted today', async () => {
    mockRunDataQualityChecks.mockResolvedValue([
      { id: 'ohlcv-freshness-coverage', label: 'OHLCV freshness', category: 'ohlcv', critical: true, status: 'fail', detail: 'stale' },
    ]);
    await checkAndAlertDataQuality(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toContain('OHLCV freshness');
    expect(mockMarkAlerted).toHaveBeenCalledWith('ohlcv-freshness-coverage', Date.UTC(2026, 6, 2));
  });

  it('alerts for a critical check in error state too', async () => {
    mockRunDataQualityChecks.mockResolvedValue([
      { id: 'some-check', label: 'Some Check', category: 'ohlcv', critical: true, status: 'error', detail: 'query threw' },
    ]);
    await checkAndAlertDataQuality(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  // Live 2026-08-04, 08:40 IST: data-quality-daily's detail strings routinely embed raw
  // snake_case table names ("mf_sector_allocation is empty"), and Telegram's legacy Markdown
  // parser aborts the ENTIRE message on the unbalanced underscore -- "Failed to dispatch
  // telegram notification: can't parse entities". Confirms sanitizeMarkdown is actually wired
  // into the outgoing text, not just present as an unused import.
  it('strips markdown-breaking characters from a table-name-bearing detail before sending', async () => {
    mockRunDataQualityChecks.mockResolvedValue([
      {
        id: 'mf-sector-allocation-freshness',
        label: 'MF sector allocation',
        category: 'ownership',
        critical: true,
        status: 'fail',
        detail: 'mf_sector_allocation is empty (0 rows) -- *never* populated, see [fetcher] `logs`',
      },
    ]);
    await checkAndAlertDataQuality(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0] as string;
    // The message legitimately keeps its own *bold*/`code` formatting -- only the interpolated
    // detail text (everything after the label's closing backtick) must be free of raw entities.
    const detailPortion = sent.split('\n')[1];
    expect(detailPortion).not.toMatch(/[_*`[\]]/);
    expect(detailPortion).toBe('mf sector allocation is empty (0 rows) -- never populated, see fetcher logs');
  });

  it('does not alert for a critical check in pass/warn state', async () => {
    mockRunDataQualityChecks.mockResolvedValue([
      { id: 'a', label: 'A', category: 'ohlcv', critical: true, status: 'pass', detail: 'ok' },
      { id: 'b', label: 'B', category: 'ohlcv', critical: true, status: 'warn', detail: 'borderline' },
    ]);
    await checkAndAlertDataQuality(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not alert for a non-critical check even if failing', async () => {
    mockRunDataQualityChecks.mockResolvedValue([
      { id: 'noncrit', label: 'Noncrit', category: 'ohlcv', critical: false, status: 'fail', detail: 'oops' },
    ]);
    await checkAndAlertDataQuality(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not re-alert if wasAlreadyAlerted returns true for today', async () => {
    mockRunDataQualityChecks.mockResolvedValue([
      { id: 'ohlcv-freshness-coverage', label: 'OHLCV freshness', category: 'ohlcv', critical: true, status: 'fail', detail: 'stale' },
    ]);
    mockWasAlreadyAlerted.mockResolvedValue(true);
    await checkAndAlertDataQuality(new Date('2026-07-02T12:00:00Z'));
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('buildDailyDigest', () => {
  beforeEach(() => {
    mockDbGet.mockReset().mockResolvedValue(undefined);
    mockDbRun.mockReset().mockResolvedValue({ changes: 0, lastInsertRowid: 0 });
    mockDbAll.mockReset().mockResolvedValue([]);
    mockGetLatestDataQualityResults.mockReset().mockResolvedValue([]);
    mockRunDataQualityChecks.mockClear();
    mockReadFileSync.mockReset().mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockGetLateJobs.mockResolvedValue([]);
    mockGetSystemStatus.mockResolvedValue([]);
  });

  it('lists a late registry job and a stale script under "Needs attention"', async () => {
    mockGetLateJobs.mockResolvedValue([
      { job: 'critical-job', label: 'Critical Job', expectedAt: new Date('2026-07-02T10:00:00Z'), hoursLate: 2, lastError: null },
    ]);
    mockGetSystemStatus.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'stale', lastRunAt: '2026-06-28T09:00:00Z', critical: true },
    ]);
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Needs attention');
    expect(digest).toContain('Critical Job');
    expect(digest).toContain('Technical Signal Scan');
    // Healthy, never-before-seen "Noncritical Job" isn't spammed into the digest body —
    // first-seen keys are recorded but not diffed/listed until the next run.
    expect(digest).not.toContain('Noncritical Job');
  });

  it('reports a recovery in "Changed since last report" when a previously-stale item turns healthy', async () => {
    mockDbGet.mockResolvedValue({
      value: JSON.stringify({ 'registry:critical-job': 'ontime', 'script:technical-scan': 'stale' }),
    });
    mockGetLateJobs.mockResolvedValue([]); // critical-job on time again
    mockGetSystemStatus.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'success', lastRunAt: '2026-07-02T09:00:00Z', critical: true },
    ]);
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Changed since last report');
    expect(digest).toContain('Technical Signal Scan');
    expect(digest).toContain('recovered');
    expect(digest).not.toContain('Needs attention');
  });

  it('reports a compact "all healthy, unchanged" summary when nothing changed and nothing is wrong', async () => {
    mockDbGet.mockResolvedValue({
      value: JSON.stringify({ 'registry:critical-job': 'ontime', 'registry:noncritical-job': 'ontime', 'script:technical-scan': 'success' }),
    });
    mockGetLateJobs.mockResolvedValue([]);
    mockGetSystemStatus.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'success', lastRunAt: '2026-07-02T09:00:00Z', critical: true },
    ]);
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Nothing changed since the last report');
    expect(digest).toContain('3 other job(s) healthy and unchanged');
    expect(digest).not.toContain('Needs attention');
    expect(digest).not.toContain('Changed since last report');
  });

  it('persists the current state for the next run to diff against', async () => {
    mockGetLateJobs.mockResolvedValue([]);
    mockGetSystemStatus.mockResolvedValue([
      { id: 'technical-scan', label: 'Technical Signal Scan', runState: 'success', lastRunAt: '2026-07-02T09:00:00Z', critical: true },
    ]);
    await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(mockDbRun).toHaveBeenCalled();
    const call = mockDbRun.mock.calls[0] as unknown as [string, any[]];
    const saved = JSON.parse(call[1][1]);
    expect(saved).toMatchObject({ 'registry:critical-job': 'ontime', 'script:technical-scan': 'success' });
  });

  it('lists a failing critical data-quality check under "Needs attention" and reads it from the persisted table, not a fresh run', async () => {
    mockGetLateJobs.mockResolvedValue([]);
    mockGetSystemStatus.mockResolvedValue([]);
    mockGetLatestDataQualityResults.mockResolvedValue([
      { id: 'ohlcv-freshness-coverage', label: 'OHLCV freshness', category: 'ohlcv', critical: true, status: 'fail', detail: 'Latest bar is 6.0d old' },
    ]);
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Needs attention');
    expect(digest).toContain('OHLCV freshness');
    expect(digest).toContain('Latest bar is 6.0d old');
    expect(mockRunDataQualityChecks).not.toHaveBeenCalled();
  });

  // job-runtime-audit (2026-08-19): the deterministic, dailyable slice of that audit.
  it('flags a job whose failure rate crosses the warn threshold with enough runs to mean something', async () => {
    mockDbAll.mockResolvedValue([
      { job_name: 'ml-daily-ops', run_count: 89, fail_count: 44 },
    ]);
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Job-runtime health');
    expect(digest).toContain('ml-daily-ops');
    expect(digest).toContain('49%');
  });

  it('does not flag a job below the fail-rate threshold or with too few runs to judge', async () => {
    mockDbAll.mockResolvedValue([
      { job_name: 'healthy-job', run_count: 40, fail_count: 2 }, // 5% -- fine
    ]);
    // run_count < MIN_RUNS_FOR_FAIL_RATE is filtered at the query level (mocked here as if the
    // SQL WHERE already excluded it), so only the healthy row reaches the flag logic.
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).not.toContain('Job-runtime health');
  });

  it('flags a job with more than one real catch-up queued in the last 24h', async () => {
    // getRecentCatchupCounts reads TWO files (today + yesterday); mockImplementationOnce so the
    // "yesterday" call still hits the default ENOENT throw instead of double-reading this content.
    mockReadFileSync.mockImplementationOnce(() =>
      [
        '{"message":"[QUEUE] Job trendlyne-midweek-batch in trendlyne-midweek missed its scheduled run. Catch-up queued with a 110min stagger."}',
        '{"message":"[QUEUE] Job trendlyne-midweek-batch in trendlyne-midweek missed its scheduled run. Catch-up queued with a 75min stagger."}',
      ].join('\n'),
    );
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).toContain('Job-runtime health');
    expect(digest).toContain('trendlyne-midweek-batch');
    expect(digest).toContain('2 catch-ups');
  });

  it('does not flag a job with exactly one real catch-up (one genuine outage, correctly caught once)', async () => {
    mockReadFileSync.mockImplementationOnce(() =>
      '{"message":"[QUEUE] Job ml-daily-ops in ml-daily-ops missed its scheduled run. Catch-up queued with a 55min stagger."}',
    );
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).not.toContain('Job-runtime health');
  });

  it('does not count a deduped "skipping duplicate catch-up" line as a real catch-up', async () => {
    mockReadFileSync.mockImplementationOnce(() =>
      [
        '{"message":"[QUEUE] Job ml-daily-ops in ml-daily-ops missed its scheduled run. Catch-up queued with a 55min stagger."}',
        '{"message":"[QUEUE] Job ml-daily-ops in ml-daily-ops missed its scheduled run, but an instance is already active/waiting/delayed -- skipping duplicate catch-up."}',
      ].join('\n'),
    );
    const digest = await buildDailyDigest(new Date('2026-07-02T15:30:00Z'));
    expect(digest).not.toContain('Job-runtime health');
  });
});
