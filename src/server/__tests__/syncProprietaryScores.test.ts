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
    financialData: { fin_score: 72 },
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
  // Both rows for INFY should be in the same tx call
  expect(mockRun).toHaveBeenCalledTimes(4); // 2 rows × 2 stocks
});
