import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDbGet, mockFetchTrendlyne } = vi.hoisted(() => ({
  mockDbGet: vi.fn(),
  mockFetchTrendlyne: vi.fn(),
}));

vi.mock('../dbAsync', () => ({ dbGet: mockDbGet }));
vi.mock('../stockMapping', () => ({ getStockMapping: vi.fn().mockReturnValue(undefined) }));
vi.mock('../cacheService', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../trendlyneAuthService', () => ({ fetchTrendlyneWithAuth: mockFetchTrendlyne }));

const { fetchTrendlyneStockMetrics } = await import('../trendlyneService');

describe('Trendlyne stock-id resolution', () => {
  beforeEach(() => {
    mockDbGet.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM nse_stocks')) return { tlid: '785' };
      if (sql.includes('FROM trendlyne_screener_stocks')) return { stock_id: 'LMW' };
      return undefined;
    });
    mockFetchTrendlyne.mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({ body: { PEG_TTM: { value: 1.2 } } }),
    });
  });

  it('uses the canonical numeric nse_stocks.tlid before symbol-shaped screener debris', async () => {
    const result = await fetchTrendlyneStockMetrics('LMW');
    expect(result?.body).toBeTruthy();
    expect(mockFetchTrendlyne).toHaveBeenCalledTimes(1);
    expect(mockFetchTrendlyne.mock.calls[0][0]).toContain('/785/');
    expect(mockFetchTrendlyne.mock.calls[0][0]).not.toContain('/LMW/');
  });
});
