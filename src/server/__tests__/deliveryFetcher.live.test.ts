/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * deliveryFetcher.ts had NO test coverage at all (mocked or otherwise) before this file —
 * found 2026-08-13 in a data-coverage-audit sweep of the ~10 TS files that persist data from
 * an external API (the Python side already had a `live_datasource` test on all 68 of its
 * fetchers; the TS side had never had its own sweep).
 *
 * Hits NSE's real bhavcopy archive for one real completed trading day, parses with the
 * fetcher's own fetchDeliveryMap() (not a hand-rolled CSV reimplementation), and reads a real
 * liquid symbol's row back from stock_delivery_data. No cleanup: the write is genuine,
 * correct production data (the same row the nightly pipeline would produce for this date),
 * not test fixture pollution -- there is nothing to delete afterward.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/deliveryFetcher.live.test.ts
  *
 * LIVE_DATE_SAFE: resolves its date from `MAX(date) FROM stock_ohlcv WHERE date < CURRENT_DATE` -- a session the platform already knows closed, never the clock.
 * (Declared for liveTestTradingDayGuard.test.ts -- see it for why this must be stated.)
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

const { fetchDeliveryMap } = await import('../deliveryFetcher');
const { dbGet } = await import('../dbAsync');
// A real, always-liquid large-cap that trades every session -- not a hardcoded ID, just a
// well-known symbol certain to appear in any recent bhavcopy (matches the pattern the Python
// live_datasource tests use, e.g. RELIANCE/HDFCBANK as the "one real ticker").
const TEST_SYMBOL = 'RELIANCE';
// A recent COMPLETED trading day -- NSE only publishes a day's bhavcopy after that session's
// close, so "today" can 404 depending on time-of-day. stock_ohlcv's own MAX(date) is the
// platform's own definition of "most recent day we know closed" (same anchor measurement.md
// mandates elsewhere), read live rather than hardcoded so this test doesn't go stale.
async function lastKnownTradingDate(): Promise<string> {
  const row = await dbGet<{ d: string }>(
    `SELECT MAX(date)::text AS d FROM stock_ohlcv WHERE date < CURRENT_DATE`,
  );
  if (!row?.d) throw new Error('stock_ohlcv has no rows -- cannot resolve a trading date to test against');
  return row.d;
}

describe.runIf(RUN_LIVE)('deliveryFetcher [live]', () => {
  it('fetches real NSE bhavcopy delivery data and persists ML-usable rows', async () => {
    const scanDate = await lastKnownTradingDate();
    const map = await fetchDeliveryMap(scanDate);

    expect(map.size, 'fetchDeliveryMap returned nothing for a known completed trading day').toBeGreaterThan(0);
    expect(map.has(TEST_SYMBOL), `${TEST_SYMBOL} missing from the parsed delivery map`).toBe(true);

    const pctFromMap = map.get(TEST_SYMBOL)!;
    expect(Number.isFinite(pctFromMap)).toBe(true);
    expect(pctFromMap).toBeGreaterThanOrEqual(0);
    expect(pctFromMap).toBeLessThanOrEqual(100);

    const row = await dbGet<{ symbol: string; delivery_pct: number; delivery_qty: number; traded_qty: number }>(
      `SELECT symbol, delivery_pct, delivery_qty, traded_qty FROM stock_delivery_data
       WHERE symbol = ? AND date = ?`,
      [TEST_SYMBOL, scanDate],
    );
    expect(row, 'row not found in stock_delivery_data after fetchDeliveryMap wrote it').toBeTruthy();
    expect(row!.symbol).toBe(TEST_SYMBOL);
    expect(Number.isFinite(row!.delivery_pct)).toBe(true);
    expect(Number.isFinite(row!.delivery_qty)).toBe(true);
    expect(Number.isFinite(row!.traded_qty)).toBe(true);
    expect(row!.traded_qty).toBeGreaterThan(0);
  }, 30000);
});
