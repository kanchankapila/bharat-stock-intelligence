import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the 2026-08-07 dead-column fix: nse_stocks.market_cap/pe_ratio/
 * dividend_yield had zero writer anywhere in the codebase (live-verified 0/2,366 ACTIVE rows
 * populated), despite every reader (getStockList/searchNSEStocks/etc.) already reading them
 * as a COALESCE fallback behind stock_fundamentals -- a structurally-dead fallback rather than
 * a live bug, since stock_fundamentals covers ~94% of the universe. backfillNseStocksFundamentalsFallback()
 * makes the fallback real for the remaining gap instead of leaving it permanently unreachable.
 */

const mockDbRun = vi.fn().mockResolvedValue({ changes: 2121 });
vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(),
  dbAll: vi.fn(),
  dbRun: (...args: any[]) => mockDbRun(...args),
  dbTransaction: vi.fn(),
}));
vi.mock('../../data/nseStocks', () => ({
  getAllNSEStocks: vi.fn().mockReturnValue([]),
  getNSEStockBySymbol: vi.fn(),
  searchNSEStocks: vi.fn(),
}));

const { backfillNseStocksFundamentalsFallback } = await import('../nseService');

beforeEach(() => {
  mockDbRun.mockClear();
});

describe('backfillNseStocksFundamentalsFallback', () => {
  it('runs a single UPDATE against nse_stocks joined to stock_fundamentals', async () => {
    await backfillNseStocksFundamentalsFallback();
    expect(mockDbRun).toHaveBeenCalledTimes(1);
    const sql = mockDbRun.mock.calls[0][0] as string;
    expect(sql).toMatch(/UPDATE nse_stocks/);
    expect(sql).toMatch(/stock_fundamentals/);
  });

  it('never downgrades an existing value (COALESCE(column, ...) on every SET, never a bare overwrite)', async () => {
    await backfillNseStocksFundamentalsFallback();
    const sql = mockDbRun.mock.calls[0][0] as string;
    expect(sql).toMatch(/market_cap\s*=\s*COALESCE\(market_cap,/);
    expect(sql).toMatch(/pe_ratio\s*=\s*COALESCE\(pe_ratio,/);
    expect(sql).toMatch(/dividend_yield\s*=\s*COALESCE\(dividend_yield,/);
  });

  it('avoids Postgres-only UPDATE...FROM syntax (uses correlated subqueries instead, safe on both dialects)', async () => {
    await backfillNseStocksFundamentalsFallback();
    const sql = mockDbRun.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/\bFROM stock_fundamentals\s+sf\s+WHERE\s+sf\.symbol\s*=\s*nse_stocks\.symbol\s*$/im);
    // The only "FROM stock_fundamentals" occurrences should be inside a SELECT subquery or the
    // WHERE symbol IN (...) clause, never a bare UPDATE-level FROM join.
    expect(sql).toMatch(/SELECT sf\.market_cap\s+FROM stock_fundamentals sf WHERE sf\.symbol = nse_stocks\.symbol/);
  });

  it('returns the real updated count from dbRun', async () => {
    const result = await backfillNseStocksFundamentalsFallback();
    expect(result).toEqual({ updated: 2121 });
  });

  it('returns 0 (not throw) when dbRun reports no changes property', async () => {
    mockDbRun.mockResolvedValueOnce({});
    const result = await backfillNseStocksFundamentalsFallback();
    expect(result).toEqual({ updated: 0 });
  });
});

describe('nse-sync-weekly wiring for the fundamentals-fallback backfill', () => {
  const SOURCE = readFileSync(join(__dirname, '..', 'jobs', 'sync.jobs.ts'), 'utf8');

  it('processNSESync calls backfillNseStocksFundamentalsFallback', () => {
    expect(SOURCE).toMatch(/backfillNseStocksFundamentalsFallback/);
    expect(SOURCE).toMatch(/import\(['"]\.\.\/nseService['"]\)/);
  });

  it('runs after the NSE stocks/sector sync steps, not before (needs nse_stocks rows to exist)', () => {
    const nseSyncIdx = SOURCE.indexOf('syncNSEStocksToDatabase()');
    const backfillIdx = SOURCE.indexOf('backfillNseStocksFundamentalsFallback');
    expect(nseSyncIdx).toBeGreaterThan(-1);
    expect(backfillIdx).toBeGreaterThan(-1);
    expect(nseSyncIdx).toBeLessThan(backfillIdx);
  });
});
