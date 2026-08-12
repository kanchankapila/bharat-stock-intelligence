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

// syncTrendlyneScores does two structurally different things, and these tests keep them apart:
//   1. a PER-SYMBOL loop upserting proprietary_scores_history (parameterised tx.run(sql, params))
//   2. one SET-BASED stamp of trendlyne_dvm_scores onto technical_signals.dvm_* (tx.run(sql), no
//      params) -- added 2026-08-13 because those three columns had no writer at all while
//      ml_ensemble.py read them as a hardcoded 50.0 for every stock.
// Counting bare dbTransaction calls would conflate the two, so split on whether params exist.
const insertCalls = () => mockRun.mock.calls.filter((c) => Array.isArray(c[1]));
const stampCalls = () => mockRun.mock.calls.filter((c) => !Array.isArray(c[1]));

test('writes durability/valuation/momentum rows when DVM data exists in the DB', async () => {
  mockGetDvm.mockResolvedValue({
    durability: { score: 72, color: 'green' },
    valuation: { score: 45, color: 'yellow' },
    momentum: { score: 88, color: 'green' },
  });

  await syncTrendlyneScores();

  expect(insertCalls()).toHaveLength(3);
  const scoreTypes = insertCalls().map((call) => call[1][2]);
  expect(scoreTypes.sort()).toEqual(['durability', 'momentum', 'valuation']);
});

test('skips a stock cleanly when no DVM data exists yet (no rows written to proprietary_scores_history)', async () => {
  mockGetDvm.mockResolvedValue(null);

  await syncTrendlyneScores();

  // The original guarantee, stated precisely: the per-symbol path must write nothing. The
  // set-based stamp below still runs (it is independent of this loop and matches 0 rows when
  // there is no DVM data), which is why this no longer asserts on dbTransaction call count.
  expect(insertCalls()).toHaveLength(0);
});

test('stamps DVM onto technical_signals exactly once, regardless of per-symbol results', async () => {
  mockGetDvm.mockResolvedValue(null);
  await syncTrendlyneScores();

  expect(stampCalls()).toHaveLength(1);
  const sql = stampCalls()[0][0] as string;
  expect(sql).toContain('UPDATE technical_signals');
  expect(sql).toContain('trendlyne_dvm_scores');
  // Point-in-time safety: the join MUST be on date as well as symbol. Dropping the date
  // predicate would smear the latest DVM snapshot across every historical grid row -- exactly
  // the look-ahead leak extra_features_parser.py was fixed for in 2026-07.
  expect(sql).toContain('d.date = ts.date::text');
});
