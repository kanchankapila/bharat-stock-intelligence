/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * The mandatory test for trendlyne_stock_metrics_history (data-sources.md). Since 2026-11-19
 * (AF-20261119-03) the daily job reads Trendlyne's anonymous custom-query screener in bulk, so
 * this calls the fetcher's own URL builder (bulkMetricsUrl), parser (parseBulkMetricsPage) and
 * writer (saveStockMetricsToDB) -- never a hand-rolled reimplementation of any of the three.
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

const { bulkMetricsUrl, parseBulkMetricsPage, saveStockMetricsToDB } =
  await import('../trendlyneDailyFetchService');
const { dbGet } = await import('../dbAsync');

// saveStockMetricsToDB writes `date = today` into trendlyne_stock_metrics_history, and the real
// caller never runs on a non-trading day -- QUEUE_TRENDLYNE_DAILY_FETCH's cron is '45 13 * * 1-5' (19:15 IST, after the close).
// Ungated, a weekend run of this test files a Sunday-dated row carrying Friday's market cap:
// the same phantom-clone shape that put 2,148 fabricated bars in stock_ohlcv on 2026-08-16, and
// it inflates the per-symbol distinct-date counts measurement.md's panel spec relies on.
// shouldSkipOnTradingHoliday(), not a hand-rolled getDay() check, so weekday holidays count too.
const { shouldSkipOnTradingHoliday } = await import('../marketStatusService');
const IS_TRADING_DAY = RUN_LIVE ? !(await shouldSkipOnTradingHoliday()) : false;

describe.runIf(RUN_LIVE)('trendlyneDailyFetchService bulk stock metrics [live]', () => {
  it.runIf(IS_TRADING_DAY)('fetches the first bulk page anonymously, parses it via the real parser, and ' +
     'persists ML-usable numeric values', async () => {
    const res = await fetch(bulkMetricsUrl(0), {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', Referer: 'https://kayal.trendlyne.com/' },
    });
    expect(res.status, 'bulk metrics page 0 refused').toBe(200);
    const { rows, isNextPage } = parseBulkMetricsPage(await res.json());
    // Page 0 is the 100 largest companies by market cap; nearly all carry an NSE symbol.
    expect(rows.size, 'bulk page 0 carried almost no NSE symbols -- payload shape changed?').toBeGreaterThan(50);
    expect(isNextPage).toBe(true);
    const [symbol, values] = [...rows][0];
    const populated = Object.values(values).filter(v => v !== null);
    expect(populated.length, `${symbol}: under half the mapped columns populated -- METRIC_COLUMNS stale?`)
      .toBeGreaterThan(Object.keys(values).length / 2);
    expect(values.mcap_q, `${symbol} has no market cap value -- response shape likely changed`).not.toBeNull();

    const today = new Date(Date.now() + 5.5 * 60 * 60_000).toISOString().slice(0, 10);
    await saveStockMetricsToDB(symbol, today, values);

    const written = await dbGet<Record<string, unknown>>(
      `SELECT * FROM trendlyne_stock_metrics_history WHERE symbol = ? AND date = ?`,
      [symbol, today],
    );
    expect(written, `no row found in trendlyne_stock_metrics_history for ${symbol}/${today} after saving`).toBeTruthy();
    expect(Number.isFinite(Number(written!.mcap_q))).toBe(true);
  }, 30000);
});
