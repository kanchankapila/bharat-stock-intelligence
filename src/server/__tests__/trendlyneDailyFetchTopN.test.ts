import { describe, expect, it, vi } from 'vitest';

const { dbTransaction } = await import('../dbAsync');
const { enqueueTrendlyneMetricsFetchJobs, getTrendlyneMetricSymbols } =
  await import('../trendlyneDailyFetchService');
const { TRENDLYNE_STOCK_METRICS_BLOCK_COOLDOWN_MS } =
  await import('../trendlyneTechnicalCircuit');

/**
 * 2026-08-04 job-timing audit: trendlyne-daily-fetch used to pre-warm fetchTrendlyneStockMetrics's
 * 12h cache for the ENTIRE stock universe (getAllStocks(), ~2,000 symbols) with no DB persistence
 * at all -- pure cache-warming for a low-traffic stock-detail popup, spread across a window that
 * overlaps market hours and competes with the intraday Trendlyne scan/checklist cycle for the
 * same rate budget. Restricted to the top-N by market cap instead.
 */
describe('getTrendlyneMetricSymbols (top-N by market cap)', () => {
  async function seed(rows: [string, string, string, number | null, string | null][]) {
    if (!process.env.VITEST_PG_SCHEMA?.startsWith('vitest_')) {
      throw new Error('Trendlyne fixtures require a private Vitest schema');
    }
    await dbTransaction(async tx => {
      await tx.run('DELETE FROM nse_stocks');
      if (rows.length) await tx.run(
        `INSERT INTO nse_stocks (symbol, name, status, market_cap, tlid)
         VALUES ${rows.map(() => '(?,?,?,?,?)').join(',')}`, rows.flat());
    });
  }

  it('ranks by market_cap DESC and respects the limit', async () => {
    await seed([
      ['SMALLCO', 'Small Co', 'ACTIVE', 1000, '1001'],
      ['BIGCO', 'Big Co', 'ACTIVE', 500000, '1002'],
      ['MIDCO', 'Mid Co', 'ACTIVE', 50000, '1003'],
    ]);

    const symbols = await getTrendlyneMetricSymbols(2);
    expect(symbols).toEqual(['BIGCO', 'MIDCO']);
  });

  it('excludes rows with no market_cap and inactive symbols', async () => {
    await seed([
      ['NOCAP', 'No Cap Co', 'ACTIVE', null, '1010'],
      ['DELISTED', 'Delisted Co', 'DELISTED', 999999, '1011'],
      ['REALCO', 'Real Co', 'ACTIVE', 1000, '1012'],
    ]);

    const symbols = await getTrendlyneMetricSymbols(10);
    expect(symbols).toEqual(['REALCO']);
  });

  it('excludes symbols whose supposed Trendlyne id is missing or is just the NSE symbol', async () => {
    await seed([
      ['VALID', 'Valid Co', 'ACTIVE', 1000, '12345'],
      ['LMW', 'LMW Ltd', 'ACTIVE', 900, 'LMW'],
      ['MISSING', 'Missing Id Co', 'ACTIVE', 800, null],
    ]);

    expect(await getTrendlyneMetricSymbols(10)).toEqual(['VALID']);
  });

  it('falls back to the full universe when nse_stocks has no market-cap-ranked rows', async () => {
    await seed([]);
    const symbols = await getTrendlyneMetricSymbols(5);
    // Falls back to stockData (stocklist.ts) — real symbols, not empty.
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every(s => s === s.toUpperCase())).toBe(true);
  });

  it('retries after the stock-metrics WAF cooldown instead of inside it', async () => {
    const add = vi.fn().mockResolvedValue(undefined);

    await enqueueTrendlyneMetricsFetchJobs({ add } as any, ['AAA'], 0, 'batch');

    const options = add.mock.calls[0][2];
    expect(options.attempts).toBeGreaterThanOrEqual(3);
    expect(options.backoff).toMatchObject({ type: 'exponential' });
    expect(options.backoff.delay).toBeGreaterThan(TRENDLYNE_STOCK_METRICS_BLOCK_COOLDOWN_MS);
  });
});
