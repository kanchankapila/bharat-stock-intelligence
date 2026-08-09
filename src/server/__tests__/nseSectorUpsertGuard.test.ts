import { describe, expect, it } from 'vitest';

// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.DATABASE_URL = ':memory:';
process.env.USE_POSTGRES = 'false';
const { default: db } = await import('../db');
const { dbGet } = await import('../dbAsync');
const { syncNSEStocksToDatabase } = await import('../nseService');
const { nseStocksData } = await import('../../data/nseStocks');

async function waitForRow(symbol: string, predicate: (r: any) => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await dbGet<any>('SELECT * FROM nse_stocks WHERE symbol = ?', [symbol]);
    if (row && predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${symbol} to reach expected state`);
}

describe('syncNSEStocksToDatabase — sector/industry upsert guard', () => {
  // Real seed-file entry -- nseStocks.ts hardcodes sector/industry='Unknown' for ~95% of the
  // universe (this symbol included), which is exactly the placeholder value this test guards
  // against re-clobbering a previously-backfilled real value.
  const symbol = nseStocksData[0].symbol;

  it('preserves a real backfilled sector/industry across a re-sync (no clobber to Unknown)', async () => {
    db.exec('DELETE FROM nse_stocks');
    // Seed a real classification, as if backfill_sector_mc.py already ran.
    db.prepare(
      `INSERT INTO nse_stocks (symbol, name, sector, industry, isin, status, last_updated)
       VALUES (?, ?, 'Financials', 'Banks', 'X', 'ACTIVE', datetime('now'))`
    ).run(symbol, symbol);

    await syncNSEStocksToDatabase();
    const row = await waitForRow(symbol, (r) => r.last_updated !== null && r.sector != null);

    expect(row.sector).toBe('Financials');
    expect(row.industry).toBe('Banks');
  });

  it('still populates sector/industry on a brand-new row (first-ever sync)', async () => {
    db.exec('DELETE FROM nse_stocks');

    await syncNSEStocksToDatabase();
    const row = await waitForRow(symbol, (r) => r.symbol === symbol);

    // The static seed file's own value for this symbol lands (even if that value is
    // 'Unknown' -- a brand-new row has nothing better to preserve).
    const expected = nseStocksData.find((s) => s.symbol === symbol)!;
    expect(row.sector).toBe(expected.sector);
    expect(row.industry).toBe(expected.industry);
  });

  it('takes a genuinely new, non-placeholder incoming value over a stale real one', async () => {
    db.exec('DELETE FROM nse_stocks');
    db.prepare(
      `INSERT INTO nse_stocks (symbol, name, sector, industry, isin, status, last_updated)
       VALUES (?, ?, 'Financials', 'Banks', 'X', 'ACTIVE', datetime('now'))`
    ).run(symbol, symbol);

    // Simulate the static file itself having been corrected to a real (non-Unknown) value --
    // the guard must still let a genuine correction through, not freeze the row forever.
    const original = nseStocksData.find((s) => s.symbol === symbol)!;
    const originalSector = original.sector;
    const originalIndustry = original.industry;
    original.sector = 'Materials';
    original.industry = 'Chemicals';
    try {
      await syncNSEStocksToDatabase();
      const row = await waitForRow(symbol, (r) => r.sector === 'Materials');
      expect(row.sector).toBe('Materials');
      expect(row.industry).toBe('Chemicals');
    } finally {
      original.sector = originalSector;
      original.industry = originalIndustry;
    }
  });
});
