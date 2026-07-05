import { vi, test, expect, beforeEach, afterEach } from 'vitest';

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
  vi.useFakeTimers();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(jsonResponse({ head: { status: '0' }, body: { tableData: [] } }));
});

afterEach(() => {
  vi.useRealTimers();
});

test('a call with a short maxAgeMs treats data older than that as stale, exercising the expiry path on a third call', async () => {
  // First call: fetch the screener data
  const p1 = fetchTrendlyneScreenerData('123', 'Test Screener', 0, false, 60_000);
  vi.runAllTimers(); // Execute the jitter delay
  await p1;
  expect(mockFetch).toHaveBeenCalledTimes(1);

  // Second call within the short 60s window with skipCache=false should reuse cache, not refetch.
  const p2 = fetchTrendlyneScreenerData('123', 'Test Screener', 0, false, 60_000);
  vi.runAllTimers(); // Execute the jitter delay (if it refetches)
  await p2;
  expect(mockFetch).toHaveBeenCalledTimes(1);

  // Advance time past the 60s TTL window
  vi.advanceTimersByTime(61_000);

  // Third call after expiry window should trigger a refetch
  const p3 = fetchTrendlyneScreenerData('123', 'Test Screener', 0, false, 60_000);
  vi.runAllTimers(); // Execute the jitter delay
  await p3;
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

test('skipCache=true still always bypasses cache regardless of maxAgeMs', async () => {
  // First call: fetch without any maxAgeMs (defaults to global TTL)
  const p1 = fetchTrendlyneScreenerData('456', 'Another Screener', 0, false);
  vi.runAllTimers(); // Execute the jitter delay
  await p1;
  expect(mockFetch).toHaveBeenCalledTimes(1);

  // Second call: with skipCache=true AND an explicit maxAgeMs supplied
  // Should fetch again, proving skipCache=true takes precedence over maxAgeMs
  const p2 = fetchTrendlyneScreenerData('456', 'Another Screener', 0, true, 600_000);
  vi.runAllTimers(); // Execute the jitter delay
  await p2;
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
