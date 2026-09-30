import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchTechnical = vi.fn();
const mockDbRun = vi.fn();
const mockDbAll = vi.fn(async () => [] as any[]);

vi.mock('../dbAsync', () => ({ dbRun: mockDbRun, dbAll: mockDbAll }));
vi.mock('../trendlyneService', () => ({
  fetchTrendlyneAdvTechnicalAnalysis: mockFetchTechnical,
}));
vi.mock('../stockMapping', () => ({
  getAllStocks: vi.fn(() => [{ symbol: 'AAA' }, { symbol: 'BBB' }]),
}));

const { syncTrendlyneTechnicals } = await import('../technicalIntelligenceService');
const { _resetTrendlyneTaCircuitForTests, markTrendlyneTaBlocked } =
  await import('../trendlyneTechnicalCircuit');

describe('syncTrendlyneTechnicals vendor-block handling', () => {
  beforeEach(() => {
    _resetTrendlyneTaCircuitForTests();
    mockFetchTechnical.mockReset();
    mockDbRun.mockReset();
    mockDbAll.mockReset();
    mockDbAll.mockResolvedValue([]);
  });

  it('aborts immediately after a provider block instead of entering cooldown retries', async () => {
    mockFetchTechnical.mockImplementation(async () => {
      markTrendlyneTaBlocked('405');
      return null;
    });

    await expect(syncTrendlyneTechnicals()).rejects.toThrow(/TA vendor block \(HTTP 405\)/);
    expect(mockFetchTechnical).toHaveBeenCalledTimes(1);
  });

  it('spends the allowance stalest-first, so a daily block cannot pin the same head of the list', async () => {
    // 2026-09-29: blocks stopped the sync at ~144 of 1,860 in FIXED order every day -- the same
    // 144 names refreshed while ~810 had not been touched since mid-July.
    mockDbAll.mockResolvedValue([{ symbol: 'AAA', last_updated: '2026-09-29T17:00:00Z' }]);
    mockFetchTechnical.mockImplementation(async () => {
      markTrendlyneTaBlocked('405');
      return null;
    });
    await expect(syncTrendlyneTechnicals()).rejects.toThrow(/TA vendor block/);
    expect(mockFetchTechnical).toHaveBeenCalledTimes(1);
    expect(mockFetchTechnical.mock.calls[0][0]).toBe('BBB');
  });
});
