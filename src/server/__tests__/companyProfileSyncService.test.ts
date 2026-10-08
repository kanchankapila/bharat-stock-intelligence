import { vi, test, expect, beforeEach } from 'vitest';

const mockRunPython = vi.fn().mockResolvedValue(undefined);
vi.mock('../pythonRunner', () => ({ runPython: mockRunPython }));

const mockDbAll = vi.fn();
const mockDbRun = vi.fn().mockResolvedValue(undefined);
vi.mock('../dbAsync', () => ({
  dbAll: mockDbAll,
  dbRun: mockDbRun,
}));

const mockAnalyze = vi.fn().mockResolvedValue({ high_growth_scope: true, in_news_for_growth: false, growth_score: 80, reasoning: 'Strong fundamentals' });
vi.mock('../../services/aiService', () => ({
  analyzeCompanyProfile: mockAnalyze,
}));

const { syncAndAnalyzeCompanyProfiles } = await import('../companyProfileSyncService');

beforeEach(() => {
  mockRunPython.mockClear();
  mockDbAll.mockClear();
  mockDbRun.mockClear();
  mockAnalyze.mockClear();
  mockAnalyze.mockResolvedValue({ high_growth_scope: true, in_news_for_growth: false, growth_score: 80, reasoning: 'Strong fundamentals' });
});

test('runs trendlyne_overview_fetcher.py before reading descriptions from the DB', async () => {
  mockDbAll.mockResolvedValue([{ symbol: 'BEL', name: 'Bharat Electronics', company_description: 'BEL manufactures defence electronics.' }]);

  await syncAndAnalyzeCompanyProfiles();

  expect(mockRunPython).toHaveBeenCalledWith('trendlyne_overview_fetcher.py', expect.anything(), expect.anything());
  expect(mockAnalyze).toHaveBeenCalledWith('BEL', 'BEL manufactures defence electronics.');
  expect(mockDbRun).toHaveBeenCalledTimes(1);

  // Ordering: runPython must resolve before dbAll is invoked,
  // otherwise the DB read could race ahead of the fresh Python fetch and see stale/no data.
  expect(mockRunPython.mock.invocationCallOrder[0]).toBeLessThan(mockDbAll.mock.invocationCallOrder[0]);
});

test('skips stocks with no description without treating missing source data as a provider failure', async () => {
  mockDbAll.mockResolvedValue([{ symbol: 'XYZ', name: 'XYZ Ltd', company_description: null }]);

  const result = await syncAndAnalyzeCompanyProfiles();

  expect(mockAnalyze).not.toHaveBeenCalled();
  expect(result.failed).toBe(0);
  expect(result.processed).toBe(0);
});

test('bounds daily AI work, uses the sustainable refresh window, and processes stalest first', async () => {
  mockDbAll.mockResolvedValue([]);

  await syncAndAnalyzeCompanyProfiles();

  const [sql, params] = mockDbAll.mock.calls[0];
  expect(String(sql)).toContain('company_description IS NOT NULL');
  expect(String(sql)).toContain('ORDER BY');
  expect(String(sql)).toContain('cp.last_updated');
  expect(String(sql)).toContain('LIMIT ?');
  expect(params).toHaveLength(2);
  expect(new Date(params[0]).getTime()).toBeLessThan(Date.now() - 170 * 86_400_000);
  expect(params[1]).toBe(15);
});

test('does not persist provider failures as zero-growth facts', async () => {
  mockDbAll.mockResolvedValue([{ symbol: 'BEL', name: 'Bharat Electronics', company_description: 'Defence electronics.' }]);
  mockAnalyze.mockResolvedValue({
    error: 'QUOTA_EXCEEDED', high_growth_scope: false, in_news_for_growth: false,
    growth_score: 0, reasoning: 'AI unavailable',
  });

  const result = await syncAndAnalyzeCompanyProfiles();

  expect(mockDbRun).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: false, processed: 0, failed: 1 });
});

test('stops the batch after a daily quota error', async () => {
  mockDbAll.mockResolvedValue([
    { symbol: 'AAA', name: 'AAA', company_description: 'First.' },
    { symbol: 'BBB', name: 'BBB', company_description: 'Second.' },
  ]);
  mockAnalyze.mockResolvedValue({
    error: 'QUOTA_EXCEEDED', high_growth_scope: false, in_news_for_growth: false,
    growth_score: 0, reasoning: 'AI unavailable',
  });

  const result = await syncAndAnalyzeCompanyProfiles();

  expect(mockAnalyze).toHaveBeenCalledTimes(1);
  expect(mockDbRun).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: false, processed: 0, failed: 1 });
});
