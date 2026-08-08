import { vi, test, expect, beforeEach } from 'vitest';

// We test that dbTransaction is called ONCE per stock, not N times per row.
const mockRun = vi.fn().mockResolvedValue(undefined);
const mockTx = { run: mockRun };
const mockDbTransaction = vi.fn().mockImplementation(async (fn: any) => fn(mockTx));

vi.mock('../dbAsync', () => ({
  dbTransaction: mockDbTransaction,
}));
vi.mock('../niftytraderService', () => ({
  fetchNiftyTraderStockData: vi.fn().mockResolvedValue({
    analysisData: {
      stocktrend: { close: 110, sma_20_days: 100, sma_50_days: 100, sma_200_days: 100, performance_20_days: 5 },
    },
    // financialData no longer has a fin_score field on the real API (confirmed 2026-08-06) —
    // reflects the real current response shape so this test doesn't drift from reality again.
    financialData: { market_cap: 100, book_value: 50, stock_pe: 20, dividend_yield: 1, roce: 10, roe: 8 },
  }),
}));
vi.mock('../stockMapping', () => ({
  getAllStocks: vi.fn().mockReturnValue([{ symbol: 'INFY' }, { symbol: 'TCS' }]),
}));

const { syncNiftyTraderScores } = await import('../syncProprietaryScores');

beforeEach(() => {
  mockRun.mockClear();
  mockDbTransaction.mockClear();
});

test('syncNiftyTraderScores calls dbTransaction once per stock, not once per row', async () => {
  await syncNiftyTraderScores();
  // 2 stocks × 1 transaction each = 2 (was 2 stocks × 2 rows = 4)
  expect(mockDbTransaction).toHaveBeenCalledTimes(2);
  expect(mockRun).toHaveBeenCalledTimes(2); // 1 row (technical_rating only) × 2 stocks
});

test('syncNiftyTraderScores never writes a financial_score row (fin_score no longer exists on the live API)', async () => {
  await syncNiftyTraderScores();
  const scoreTypesWritten = mockRun.mock.calls.map((call) => call[1]?.[2]);
  expect(scoreTypesWritten).not.toContain('financial_score');
  expect(scoreTypesWritten).toEqual(['technical_rating', 'technical_rating']);
});
