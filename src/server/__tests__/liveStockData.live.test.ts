/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * liveStockData.ts had no test at all before this file (data-coverage-audit, 2026-08-13
 * TS-side sweep). Calls the service's own real entry point, fetchAndPersistOHLCVData() --
 * the exact function the scheduled live-price job calls -- rather than reimplementing the
 * fetch+parse+persist chain. No cleanup: writes genuine, correct today's-bar rows into
 * stock_ohlcv, identical to what the real job would write.
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

describe.runIf(RUN_LIVE)('liveStockData [live]', () => {
  it('fetches real live quotes for the tracked universe and persists ML-usable OHLCV rows', async () => {
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
