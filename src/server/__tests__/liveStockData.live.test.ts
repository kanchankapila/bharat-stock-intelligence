/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * liveStockData.ts had no test at all before this file (data-coverage-audit, 2026-08-13
 * TS-side sweep). Calls the service's own real entry point, fetchAndPersistOHLCVData() --
 * the exact function the scheduled live-price job calls -- rather than reimplementing the
 * fetch+parse+persist chain. No cleanup: writes genuine, correct today's-bar rows into
 * stock_ohlcv, identical to what the real job would write.
 *
 * "Identical to what the real job would write" was FALSE on a non-trading day, and the gap wrote
 * fabricated bars into production (2026-08-16). fetchAndPersistOHLCVData() stamps `new Date()`
 * unconditionally (liveStockData.ts:621); the weekday/holiday guard lives one level up in the
 * CALLER -- queues.ts's processStockRefresh() calls shouldSkipOnTradingHoliday() first,
 * deliberately, because a blanket weekend refusal inside the service would also block NSE's real
 * Saturday sessions (Budget day, Muhurat -- stock_ohlcv holds five of them). This test bypassed
 * that caller, so running it on a Saturday persisted 2,148 rows dated 2026-08-16, 2,141 of them
 * byte-identical to the 08-14 close. Now gated on the same guard the real caller uses.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/liveStockData.live.test.ts
 */
import { describe, it, expect } from 'vitest';

// Gated behind RUN_LIVE, not a static top-level `import 'dotenv/config'` -- that would load
// real credentials into process.env on EVERY vitest run (all test files share one process),
// including runs where this suite is skipped. Found live 2026-08-13: it broke
// niftytraderAuthService.test.ts's "no credentials configured" case by leaking a real
// NIFTYTRADER_EMAIL/PASSWORD into env for the whole worker. RUN_LIVE_DATASOURCE_TESTS itself
// is a plain shell env var, not something .env provides, so checking it first is safe.
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';
if (RUN_LIVE) await import('dotenv/config');

const { fetchAndPersistOHLCVData } = await import('../liveStockData');
const { dbGet } = await import('../dbAsync');
const TEST_SYMBOL = 'RELIANCE';

// The same guard processStockRefresh() applies before calling fetchAndPersistOHLCVData(), not a
// reimplementation of it -- a hand-rolled `getDay() in (0,6)` here would drift from the real
// caller and would miss weekday trading holidays entirely.
const { shouldSkipOnTradingHoliday } = await import('../marketStatusService');
const IS_TRADING_DAY = RUN_LIVE ? !(await shouldSkipOnTradingHoliday()) : false;

describe.runIf(RUN_LIVE)('liveStockData [live]', () => {
  it.runIf(IS_TRADING_DAY)('fetches real live quotes for the tracked universe and persists ML-usable OHLCV rows', async () => {
    const { count, persisted } = await fetchAndPersistOHLCVData();
    expect(count, 'fetchAllLiveStocks returned zero quotes').toBeGreaterThan(0);
    expect(persisted, 'persistTodayOHLCVData wrote zero rows').toBeGreaterThan(0);

    const today = new Date().toISOString().slice(0, 10);
    const row = await dbGet<{ symbol: string; open: number; high: number; low: number; close: number; volume: number }>(
      `SELECT symbol, open, high, low, close, volume FROM stock_ohlcv WHERE symbol = ? AND date::text = ?`,
      [TEST_SYMBOL, today],
    );
    expect(row, `no today's-date stock_ohlcv row for ${TEST_SYMBOL} after fetchAndPersistOHLCVData`).toBeTruthy();
    for (const field of ['open', 'high', 'low', 'close'] as const) {
      expect(Number.isFinite(row![field]), `${field}=${row![field]} is not finite`).toBe(true);
      expect(row![field]).toBeGreaterThan(0);
    }
    expect(Number.isFinite(row!.volume)).toBe(true);
  }, 60000);
});
