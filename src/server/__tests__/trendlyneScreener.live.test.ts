/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * trendlyneScreener.ts had no live-hitting test before this file (data-coverage-audit,
 * 2026-08-13 TS-side sweep) despite being the single largest screener source on the platform
 * (140K+ trendlyne_screener_stocks rows). Uses its own resolution (a real, already-cataloged
 * screener from getAllScreenersFromDB(), not a hardcoded screenpk), fetches via the fetcher's
 * own fetchTrendlyneScreenerData(), and persists via its own saveScreenerStocksToDB() -- not a
 * hand-rolled reimplementation of either. No cleanup: saveScreenerStocksToDB's exit-tracking
 * runs exactly as it does in the real sync (perPageCount:1000 already captures a screener in
 * one page in production), so this writes/reconciles genuine production-shaped state, not test
 * fixture pollution.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/trendlyneScreener.live.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Gated behind RUN_LIVE, not a static top-level `import 'dotenv/config'` -- that would load
// real credentials into process.env on EVERY vitest run (all test files share one process),
// including runs where this suite is skipped. Found live 2026-08-13: it broke
// niftytraderAuthService.test.ts's "no credentials configured" case by leaking a real
// NIFTYTRADER_EMAIL/PASSWORD into env for the whole worker. RUN_LIVE_DATASOURCE_TESTS itself
// is a plain shell env var, not something .env provides, so checking it first is safe.
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';
if (RUN_LIVE) await import('dotenv/config');

const { getAllScreenersFromDB, fetchTrendlyneScreenerData, saveScreenerStocksToDB } = await import('../trendlyneScreener');
const { dbAll } = await import('../dbAsync');

describe.runIf(RUN_LIVE)('trendlyneScreener [live]', () => {
  let screenerId: string;
  let screenpk: string;
  let screenerName: string;

  beforeAll(async () => {
    const screeners = await getAllScreenersFromDB();
    if (screeners.length === 0) throw new Error('trendlyne_screeners is empty -- run the discovery sync first');
    const withPk = screeners.find(s => s.screenpk);
    if (!withPk) throw new Error('no trendlyne_screeners row has a screenpk');
    screenerId = withPk.screener_id;
    screenpk = withPk.screenpk;
    screenerName = withPk.screener_name;
  });

  it('fetches a real Trendlyne screener and persists ML-usable stock rows', async () => {
    const result = await fetchTrendlyneScreenerData(screenpk, screenerName, 0, true);
    expect(result.success, `fetchTrendlyneScreenerData failed for "${screenerName}" (screenpk=${screenpk})`).toBe(true);
    expect(result.data.length, `screener "${screenerName}" returned zero stocks`).toBeGreaterThan(0);

    await saveScreenerStocksToDB(screenerId, result.data.map(s => ({ stockId: s.stockId, name: s.name })));

    const written = await dbAll<{ screener_id: string; stock_id: string; symbol: string | null }>(
      `SELECT screener_id, stock_id, symbol FROM trendlyne_screener_stocks WHERE screener_id = ? LIMIT 5`,
      [screenerId],
    );
    expect(written.length, `no rows found in trendlyne_screener_stocks for screener ${screenerId} after saving`).toBeGreaterThan(0);
    for (const row of written) {
      expect(row.stock_id.length).toBeGreaterThan(0);
      // stock_id is Trendlyne's own opaque numeric id per data-sources.md -- not the NSE symbol
      expect(row.stock_id).toMatch(/^\d+$/);
    }
  }, 30000);
});
