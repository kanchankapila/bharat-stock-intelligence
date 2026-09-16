/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * mcApiService.ts had no live-hitting test before this file. The only RUN_LIVE-gated TS test
 * in the whole repo before this sweep, mcapiProxy.test.ts, tests the /mcapi/v1/* proxy
 * passthrough route -- a different code path that never calls mcApiService.ts's own
 * fetch/parse/persist functions at all (found in the data-coverage-audit that prompted this
 * whole sweep, 2026-08-13).
 *
 * Resolves scId via the mandated resolveMoneycontrolSymbol() (stockMapping.ts) -- never a
 * hardcoded id, per data-sources.md's resolution-order rule -- fetches with the real
 * getMcConsolidatedData(), and persists with the real persistMcConsolidatedMetrics() (already
 * unit-tested against fake data in mcConsolidatedMetricsPersist.test.ts; this is the missing
 * other half -- real data in). No cleanup: writes genuine production-shaped rows.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/mcApiService.live.test.ts
  *
 * LIVE_DATE_SAFE: writes mc_general_metrics / mc_swot_history, both fetched_at-stamped with no trading-date key.
 * (Declared for liveTestTradingDayGuard.test.ts -- see it for why this must be stated.)
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

const { getMcConsolidatedData, persistMcConsolidatedMetrics } = await import('../mcApiService');
const { resolveMoneycontrolSymbol } = await import('../stockMapping');
const { dbAll } = await import('../dbAsync');
const TEST_SYMBOL = 'RELIANCE';

describe.runIf(RUN_LIVE)('mcApiService [live]', () => {
  let scId: string;

  beforeAll(async () => {
    const resolved = await resolveMoneycontrolSymbol(TEST_SYMBOL);
    if (!resolved) throw new Error(`resolveMoneycontrolSymbol could not resolve ${TEST_SYMBOL}`);
    scId = resolved;
  });

  it('fetches real MoneyControl consolidated data and persists ML-usable metrics', async () => {
    const data = await getMcConsolidatedData(scId, TEST_SYMBOL);
    expect(data, `getMcConsolidatedData returned nothing for ${TEST_SYMBOL} (scId=${scId})`).toBeTruthy();

    const fetchedAt = new Date().toISOString().slice(0, 10);
    await persistMcConsolidatedMetrics(TEST_SYMBOL, {
      mcInsights: data.mcInsights,
      analystRating: data.analystRating,
      priceForecast: data.priceForecast,
      hitsMisses: data.hitsMisses,
      swot: data.swot,
      historicalRating: data.historicalRating,
    });

    const rows = await dbAll<{ metric_group: string; metric_name: string; metric_value_num: number | null; metric_value_text: string | null }>(
      `SELECT metric_group, metric_name, metric_value_num, metric_value_text FROM mc_general_metrics
       WHERE symbol = ? AND source_api = 'mc_consolidated' AND fetched_at = ?`,
      [TEST_SYMBOL, fetchedAt],
    );
    expect(rows.length, `persistMcConsolidatedMetrics wrote nothing for ${TEST_SYMBOL} today`).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.metric_value_num === null || r.metric_value_text === null).toBe(true);
      if (r.metric_value_num !== null) expect(Number.isFinite(r.metric_value_num)).toBe(true);
    }
  }, 30000);
});
