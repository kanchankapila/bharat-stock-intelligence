import { vi, test, expect, beforeEach } from 'vitest';

const mockRun = vi.fn().mockResolvedValue(undefined);
const mockTx = { run: mockRun };
const mockDbTransaction = vi.fn().mockImplementation(async (fn: any) => fn(mockTx));

vi.mock('../dbAsync', () => ({
  dbTransaction: mockDbTransaction,
}));
vi.mock('../stockMapping', () => ({
  getAllStocks: vi.fn().mockReturnValue([{ symbol: 'INFY', tlid: '1594' }]),
}));

const mockGetDvm = vi.fn();
const mockGetChecklist = vi.fn().mockResolvedValue(null);
vi.mock('../trendlyneService', () => ({
  fetchTrendlyneChecklist: mockGetChecklist,
  getTrendlyneDVMFromDb: mockGetDvm,
}));

const { syncTrendlyneScores } = await import('../syncProprietaryScores');

beforeEach(() => {
  mockRun.mockClear();
  mockDbTransaction.mockClear();
  mockGetDvm.mockReset();
  mockGetChecklist.mockClear();
});

test('writes durability/valuation/momentum rows when DVM data exists in the DB', async () => {
  mockGetDvm.mockResolvedValue({
    durability: { score: 72, color: 'green' },
    valuation: { score: 45, color: 'yellow' },
    momentum: { score: 88, color: 'green' },
  });

  await syncTrendlyneScores();

  expect(mockDbTransaction).toHaveBeenCalledTimes(1);
  expect(mockRun).toHaveBeenCalledTimes(3);
  const scoreTypes = mockRun.mock.calls.map((call) => call[1][2]);
  expect(scoreTypes.sort()).toEqual(['durability', 'momentum', 'valuation']);
});

test('skips a stock cleanly when no DVM data exists yet (no error, no rows written)', async () => {
  mockGetDvm.mockResolvedValue(null);

  await syncTrendlyneScores();

  expect(mockDbTransaction).not.toHaveBeenCalled();
});
