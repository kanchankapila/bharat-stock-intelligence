import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), run: vi.fn() }));
vi.mock('../dbAsync', () => ({ dbTransaction: mocks.transaction, dbRun: vi.fn(), dbGet: vi.fn(), dbAll: vi.fn() }));
vi.mock('../../data/nseStocks', () => ({
  getAllNSEStocks: () => [{ symbol: 'TCS', name: 'TCS', sector: 'Information Technology', industry: 'IT', isin: 'INE467B01029' }],
  getNSEStockBySymbol: vi.fn(), searchNSEStocks: vi.fn(),
}));
import { syncNSEStocksToDatabase } from '../nseService';
describe('NSE sync completion contract', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.run.mockResolvedValue({ changes: 1 }); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

  it('waits for commit and shares the in-flight completion instead of returning early success', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.transaction.mockImplementation(async (fn) => { await fn({ run: mocks.run }); await gate; });
    const first = syncNSEStocksToDatabase();
    expect(first).toBeInstanceOf(Promise);
    expect(syncNSEStocksToDatabase()).toBe(first);
    let settled = false; first.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release();
    expect(await first).toMatchObject({ success: true, written: 1, inserted: null, updated: null });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('propagates transaction failure and permits a later retry', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('commit failed'));
    const failed = syncNSEStocksToDatabase();
    expect(failed).toBeInstanceOf(Promise);
    await expect(failed).rejects.toThrow('commit failed');
    mocks.transaction.mockImplementation(async fn => fn({ run: mocks.run }));
    await expect(syncNSEStocksToDatabase()).resolves.toMatchObject({ success: true, written: 1 });
  });
});
