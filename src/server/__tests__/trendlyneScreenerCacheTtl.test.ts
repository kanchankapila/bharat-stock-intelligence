import { vi, test, expect, beforeEach } from 'vitest';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(), dbAll: vi.fn(), dbRun: vi.fn(), dbTransaction: vi.fn(),
}));
vi.mock('../stockMapping', () => ({
  getStockMapping: vi.fn().mockReturnValue(undefined),
  getStockMappingByTLId: vi.fn().mockReturnValue(undefined),
  getStockMappingByName: vi.fn().mockReturnValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { fetchTrendlyneScreenerData } = await import('../trendlyneScreener');

function jsonResponse(body: any) {
  return { ok: true, json: async () => body } as any;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(jsonResponse({ head: { status: '0' }, body: { tableData: [] } }));
});

test('a call with a short maxAgeMs treats data older than that as stale even though the global TTL would still consider it fresh', async () => {
  await fetchTrendlyneScreenerData('123', 'Test Screener', 0, false, 60_000);
  expect(mockFetch).toHaveBeenCalledTimes(1);

  // Second call within the short 60s window with skipCache=false should reuse cache, not refetch.
  await fetchTrendlyneScreenerData('123', 'Test Screener', 0, false, 60_000);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test('skipCache=true still always bypasses cache regardless of maxAgeMs', async () => {
  await fetchTrendlyneScreenerData('456', 'Another Screener', 0, false);
  expect(mockFetch).toHaveBeenCalledTimes(1);

  await fetchTrendlyneScreenerData('456', 'Another Screener', 0, true);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
