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
const mockRelease = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/aiService', () => ({
  analyzeCompanyProfile: mockAnalyze,
  releaseOllamaModel: mockRelease,
}));

const { syncAndAnalyzeCompanyProfiles } = await import('../companyProfileSyncService');

beforeEach(() => {
  mockRunPython.mockClear();
  mockDbAll.mockClear();
  mockDbRun.mockClear();
  mockAnalyze.mockClear();
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

test('skips stocks with no description without calling Ollama', async () => {
  mockDbAll.mockResolvedValue([{ symbol: 'XYZ', name: 'XYZ Ltd', company_description: null }]);

  const result = await syncAndAnalyzeCompanyProfiles();

  expect(mockAnalyze).not.toHaveBeenCalled();
  expect(result.failed).toBe(1);
  expect(result.processed).toBe(0);
});
