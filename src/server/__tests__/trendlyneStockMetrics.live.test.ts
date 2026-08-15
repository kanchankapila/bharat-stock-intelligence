/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * trendlyneDailyFetchService.ts's runTrendlyneMetricsFetch() was pure cache-warming until
 * 2026-08-15 -- every fetched value discarded after a 12h TTL, including PEG_TTM/PBV_A/INSTIHOLD,
 * confirmed live to exist nowhere else in this schema. This is the mandatory test for the new
 * write path (data-sources.md), using the fetcher's own resolution (getTrendlyneMetricSymbols(),
 * not a hardcoded symbol), its own parser (extractMetricValues()), and its own writer
 * (saveStockMetricsToDB()) -- never a hand-rolled reimplementation of any of the three.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/trendlyneStockMetrics.live.test.ts
 */
import { describe, it, expect } from 'vitest';

// Gated behind RUN_LIVE, not a static top-level `import 'dotenv/config'` -- see
// trendlyneScreener.live.test.ts's own comment for the incident that makes this mandatory
// (a static top-level dotenv import leaked real creds into process.env for the whole vitest
// worker, breaking an unrelated "no credentials configured" test in a different file).
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';
if (RUN_LIVE) await import('dotenv/config');

const { getTrendlyneMetricSymbols, extractMetricValues, saveStockMetricsToDB } =
  await import('../trendlyneDailyFetchService');
const { fetchTrendlyneStockMetrics } = await import('../trendlyneService');
const { dbGet } = await import('../dbAsync');

describe.runIf(RUN_LIVE)('trendlyneDailyFetchService stock metrics [live]', () => {
  it('fetches real Stock Metrics for a real top-market-cap symbol, parses via the real ' +
     'extractor, and persists ML-usable numeric values', async () => {
    const symbols = await getTrendlyneMetricSymbols(5);
    expect(symbols.length, 'getTrendlyneMetricSymbols returned zero symbols').toBeGreaterThan(0);
    const symbol = symbols[0];

    const data = await fetchTrendlyneStockMetrics(symbol);
    expect(data?.body, `fetchTrendlyneStockMetrics returned no body for ${symbol}`).toBeTruthy();

    const values = extractMetricValues(data!.body);
    const populated = Object.values(values).filter(v => v !== null);
    expect(populated.length, `extractMetricValues found zero populated params for ${symbol} -- ` +
      `either the response shape changed or the METRIC_COLUMNS mapping is stale`).toBeGreaterThan(0);
    // At minimum, market cap and PE should resolve for a genuine top-500-by-market-cap symbol --
    // a real assertion on shape, not just "something non-null came back".
    expect(values.mcap_q, `${symbol} has no market cap value -- response shape likely changed`).not.toBeNull();

    const today = new Date().toISOString().slice(0, 10);
    await saveStockMetricsToDB(symbol, today, data!.body);

    const written = await dbGet<Record<string, unknown>>(
      `SELECT * FROM trendlyne_stock_metrics_history WHERE symbol = ? AND date = ?`,
      [symbol, today],
    );
    expect(written, `no row found in trendlyne_stock_metrics_history for ${symbol}/${today} after saving`).toBeTruthy();
    expect(written!.mcap_q).not.toBeNull();
    expect(typeof written!.mcap_q === 'number' && Number.isFinite(written!.mcap_q as number)).toBe(true);
  }, 30000);
});
