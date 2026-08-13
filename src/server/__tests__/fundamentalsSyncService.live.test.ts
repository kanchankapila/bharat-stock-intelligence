/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * fundamentalsSyncService.ts had no live-hitting test before this file (data-coverage-audit,
 * 2026-08-13 TS-side sweep). Uses the service's own scoped single-symbol entry point,
 * refreshSymbolFundamentals() -- the same function bootstrapFundamentals()/manual refresh
 * routes call for one symbol -- rather than the full phase1/phase2 batch sync (which processes
 * the whole universe and isn't meant to run per-test). Reads back via the service's own
 * getStoredFundamentals(), not a hand-rolled SELECT. No cleanup: this is the real, correct,
 * production-shaped fundamentals row for the symbol, identical to what the real sync writes.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/fundamentalsSyncService.live.test.ts
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

const { refreshSymbolFundamentals, getStoredFundamentals } = await import('../fundamentalsSyncService');
const TEST_SYMBOL = 'RELIANCE';

describe.runIf(RUN_LIVE)('fundamentalsSyncService [live]', () => {
  it('fetches real Yahoo Finance fundamentals for one symbol and persists ML-usable data', async () => {
    await refreshSymbolFundamentals(TEST_SYMBOL);

    const row = await getStoredFundamentals(TEST_SYMBOL);
    expect(row, `no stock_fundamentals row for ${TEST_SYMBOL} after refreshSymbolFundamentals`).toBeTruthy();
    expect(row.symbol).toBe(TEST_SYMBOL);

    // At least one numeric fundamentals field should be a real finite number, not NULL/NaN/an
    // unconverted string -- matches the Python live_datasource convention
    // (assert_numeric_and_finite) rather than asserting on one specific column that phase1 vs
    // phase2 timing could legitimately leave NULL.
    const numericFields = ['market_cap', 'pe_ratio', 'trailing_pe', 'forward_pe', 'price_to_book', 'eps'];
    const present = numericFields
      .map(f => [f, row[f]])
      .filter(([, v]) => v !== null && v !== undefined);
    expect(present.length, `none of ${numericFields.join(',')} were populated for ${TEST_SYMBOL}`).toBeGreaterThan(0);
    for (const [field, value] of present) {
      expect(Number.isFinite(Number(value)), `${field}=${value} is not a finite number`).toBe(true);
    }
  }, 30000);
});
