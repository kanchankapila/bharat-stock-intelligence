import { describe, it, expect, beforeAll, afterAll } from 'vitest';

if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('confluenceFilingGrowth.test.ts refuses to run without VITEST_PG_SCHEMA (AF-20260917-19).');
}

/**
 * AF-20261105-04: HARIOMPIPE filed +65% YoY revenue on 2026-11-04 and confluence kept scoring the
 * vendor's -6.9% from the 10-31 sync. The quarter's own filing is the fresher number we already hold.
 */
const { loadFilingRevenueGrowth } = await import('../confluenceEngine');
const { dbTransaction } = await import('../dbAsync');
const SCHEMA = process.env.VITEST_PG_SCHEMA;

const row = (sym: string, end: string, cons: boolean, rev: number, ago: string) =>
  `('${sym}', '${end}', ${cons}, ${rev}, now() - interval '${ago}')`;

beforeAll(async () => {
  await dbTransaction(async tx => {
    await tx.run(`DROP TABLE IF EXISTS "${SCHEMA}".nse_filing_financials`);
    await tx.run(`CREATE TABLE "${SCHEMA}".nse_filing_financials (
      symbol TEXT, period_end DATE, consolidated BOOLEAN, revenue DOUBLE PRECISION, broadcast_ts TIMESTAMPTZ)`);
    await tx.run(`INSERT INTO "${SCHEMA}".nse_filing_financials VALUES
      ${row('FRESH', '2026-09-30', true, 554, '1 day')},
      ${row('FRESH', '2025-09-30', true, 336, '1 year')},
      ${row('FRESH', '2026-09-30', false, 100, '1 day')},
      ${row('FRESH', '2025-09-30', false, 100, '1 year')},
      ${row('OLD', '2026-03-31', true, 200, '200 days')},
      ${row('OLD', '2025-03-31', true, 100, '1 year')},
      ${row('NOBASE', '2026-09-30', true, 200, '1 day')},
      ${row('WILD', '2026-09-30', true, 5000, '1 day')},
      ${row('WILD', '2025-09-30', true, 1, '1 year')}`);
  });
});

afterAll(async () => {
  await dbTransaction(async tx => { await tx.run(`DROP TABLE IF EXISTS "${SCHEMA}".nse_filing_financials`); });
});

describe('loadFilingRevenueGrowth', () => {
  it('returns recent YoY growth, preferring consolidated', async () => {
    const g = await loadFilingRevenueGrowth();
    expect(g.get('FRESH')).toBeCloseTo(554 / 336 - 1, 5);
  });

  it('leaves the vendor value alone when the filing is old, unpaired or implausible', async () => {
    const g = await loadFilingRevenueGrowth();
    expect(g.has('OLD')).toBe(false);
    expect(g.has('NOBASE')).toBe(false);
    expect(g.has('WILD')).toBe(false);
  });
});
