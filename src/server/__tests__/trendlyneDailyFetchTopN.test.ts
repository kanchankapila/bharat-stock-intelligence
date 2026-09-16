import { describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
const { getTrendlyneMetricSymbols } = await import('../trendlyneDailyFetchService');

/**
 * 2026-08-04 job-timing audit: trendlyne-daily-fetch used to pre-warm fetchTrendlyneStockMetrics's
 * 12h cache for the ENTIRE stock universe (getAllStocks(), ~2,000 symbols) with no DB persistence
 * at all -- pure cache-warming for a low-traffic stock-detail popup, spread across a window that
 * overlaps market hours and competes with the intraday Trendlyne scan/checklist cycle for the
 * same rate budget. Restricted to the top-N by market cap instead.
 */
describe('getTrendlyneMetricSymbols (top-N by market cap)', () => {
  it('ranks by market_cap DESC and respects the limit', async () => {
    await dbExec('DELETE FROM nse_stocks');
    const insert = "INSERT INTO nse_stocks (symbol, name, status, market_cap) VALUES (?, ?, 'ACTIVE', ?)";
    await dbRun(insert, ['SMALLCO', 'Small Co', 1000]);
    await dbRun(insert, ['BIGCO', 'Big Co', 500000]);
    await dbRun(insert, ['MIDCO', 'Mid Co', 50000]);

    const symbols = await getTrendlyneMetricSymbols(2);
    expect(symbols).toEqual(['BIGCO', 'MIDCO']);
  });

  it('excludes rows with no market_cap and inactive symbols', async () => {
    await dbExec('DELETE FROM nse_stocks');
    const insert = "INSERT INTO nse_stocks (symbol, name, status, market_cap) VALUES (?, ?, ?, ?)";
    await dbRun(insert, ['NOCAP', 'No Cap Co', 'ACTIVE', null]);
    await dbRun(insert, ['DELISTED', 'Delisted Co', 'DELISTED', 999999]);
    await dbRun(insert, ['REALCO', 'Real Co', 'ACTIVE', 1000]);

    const symbols = await getTrendlyneMetricSymbols(10);
    expect(symbols).toEqual(['REALCO']);
  });

  it('falls back to the full universe when nse_stocks has no market-cap-ranked rows', async () => {
    await dbExec('DELETE FROM nse_stocks');
    const symbols = await getTrendlyneMetricSymbols(5);
    // Falls back to stockData (stocklist.ts) — real symbols, not empty.
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every(s => s === s.toUpperCase())).toBe(true);
  });
});
