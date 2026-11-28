import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchTechnical = vi.fn();
const mockDbRun = vi.fn();
const mockStockId = vi.fn(async (_symbol: string): Promise<string | undefined> => '1');
const mockDbAll = vi.fn(async () => [] as any[]);
const mockGetAllStocks = vi.fn(() => [{ symbol: 'AAA' }, { symbol: 'BBB' }]);

vi.mock('../dbAsync', () => ({ dbRun: mockDbRun, dbAll: mockDbAll }));
vi.mock('../trendlyneService', () => ({
  fetchTrendlyneAdvTechnicalAnalysis: mockFetchTechnical,
  trendlyneTaStockId: mockStockId,
}));
vi.mock('../stockMapping', () => ({
  getAllStocks: mockGetAllStocks,
}));

const { syncTrendlyneTechnicals, DEFAULT_TRENDLYNE_TA_DAILY_SLICE } =
  await import('../technicalIntelligenceService');
const { _resetTrendlyneTaCircuitForTests, markTrendlyneTaBlocked } =
  await import('../trendlyneTechnicalCircuit');

describe('syncTrendlyneTechnicals vendor-block handling', () => {
  beforeEach(() => {
    _resetTrendlyneTaCircuitForTests();
    mockFetchTechnical.mockReset();
    mockStockId.mockReset();
    mockStockId.mockResolvedValue('1');
    mockDbRun.mockReset();
    mockDbAll.mockReset();
    mockDbAll.mockResolvedValue([]);
    mockGetAllStocks.mockReset();
    mockGetAllStocks.mockReturnValue([{ symbol: 'AAA' }, { symbol: 'BBB' }]);
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

  it('completes a bounded stalest-first slice below the measured vendor allowance', async () => {
    const universe = Array.from(
      { length: DEFAULT_TRENDLYNE_TA_DAILY_SLICE + 7 },
      (_, i) => ({ symbol: `S${String(i).padStart(3, '0')}` }),
    );
    mockGetAllStocks.mockReturnValue(universe);
    mockFetchTechnical.mockResolvedValue({ body: { parameters: {} } });

    const oldDelay = process.env.TRENDLYNE_BASE_DELAY_MS;
    process.env.TRENDLYNE_BASE_DELAY_MS = '0';
    try {
      await expect(syncTrendlyneTechnicals()).resolves.toBeUndefined();
    } finally {
      if (oldDelay === undefined) delete process.env.TRENDLYNE_BASE_DELAY_MS;
      else process.env.TRENDLYNE_BASE_DELAY_MS = oldDelay;
    }

    expect(mockFetchTechnical).toHaveBeenCalledTimes(DEFAULT_TRENDLYNE_TA_DAILY_SLICE);
    expect(mockFetchTechnical.mock.calls.at(-1)?.[0]).toBe('S109');
  });

  it('does not spend the slice on a symbol with no Trendlyne id (it can never be written, so it stays stalest)', async () => {
    mockStockId.mockImplementation(async (symbol: string) => (symbol === 'AAA' ? undefined : '1'));
    mockFetchTechnical.mockImplementation(async () => {
      markTrendlyneTaBlocked('405');
      return null;
    });
    await expect(syncTrendlyneTechnicals(1)).rejects.toThrow(/TA vendor block/);
    expect(mockFetchTechnical.mock.calls.map((c) => c[0])).toEqual(['BBB']);
  });

  it('really aborts after repeated cooldowns with no success', async () => {
    vi.useFakeTimers();
    try {
      mockGetAllStocks.mockReturnValue(Array.from({ length: 40 }, (_, i) => ({ symbol: `S${i}` })));
      mockFetchTechnical.mockResolvedValue(null);
      const outcome = expect(syncTrendlyneTechnicals()).rejects.toThrow(/sustained fetch failures/);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await outcome;
      expect(mockFetchTechnical).toHaveBeenCalledTimes(20);
    } finally {
      vi.useRealTimers();
    }
  });
});
