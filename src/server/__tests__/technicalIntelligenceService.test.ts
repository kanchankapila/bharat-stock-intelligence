import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchTechnical = vi.fn();
const mockDbRun = vi.fn();

vi.mock('../dbAsync', () => ({ dbRun: mockDbRun }));
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
  });

  it('aborts immediately after a provider block instead of entering cooldown retries', async () => {
    mockFetchTechnical.mockImplementation(async () => {
      markTrendlyneTaBlocked('405');
      return null;
    });

    await expect(syncTrendlyneTechnicals()).rejects.toThrow(/TA vendor block \(HTTP 405\)/);
    expect(mockFetchTechnical).toHaveBeenCalledTimes(1);
  });
});
