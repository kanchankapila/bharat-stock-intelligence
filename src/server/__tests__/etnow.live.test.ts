/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * etnow.ts had no live-hitting test before this file (data-coverage-audit, 2026-08-13 TS-side
 * sweep). Uses its own resolution (a real, already-seeded screener from etnow_screeners, not a
 * hardcoded screenerId), fetches via the fetcher's own fetchETnowScreener(), and extracts
 * symbol/stockName using the IDENTICAL field-fallback expression etnowScreenerSync.ts uses (not
 * a divergent reimplementation). Writes via the same upsert shape that sync uses for the
 * "current" half of its logic -- deliberately skips the sync's exit-reconciliation DELETE step,
 * which is orchestration logic (diffing this fetch's page against whatever the last real sync
 * saw), not fetch/parse logic, and running it here on a single-page fetch risks deleting real
 * rows the last full sync legitimately wrote. No cleanup otherwise: the upsert writes genuine
 * production-shaped rows.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/etnow.live.test.ts
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

const { fetchETnowScreener } = await import('../etnow');
const { dbAll, dbRun, dbGet } = await import('../dbAsync');

describe.runIf(RUN_LIVE)('etnow [live]', () => {
  let screenerId: string;
  let queryCondition: string;

  beforeAll(async () => {
    const rows = await dbAll<{ screener_id: string; query_condition: string | null }>(
      `SELECT screener_id, query_condition FROM etnow_screeners LIMIT 1`,
    );
    if (rows.length === 0) throw new Error('etnow_screeners is empty -- run initEtnowScreeners() first');
    screenerId = rows[0].screener_id;
    queryCondition = '';
    if (rows[0].query_condition) {
      try {
        const outer = JSON.parse(rows[0].query_condition);
        const inner = typeof outer === 'string' ? JSON.parse(outer) : outer;
        queryCondition = inner?.queryCondition ?? '';
      } catch { /* fall back to empty string, same as etnowScreenerSync.ts */ }
    }
  });

  it('fetches a real ETnow screener and persists ML-usable stock rows', async () => {
    const response = await fetchETnowScreener(screenerId, queryCondition);
    const records = response.dataList || response.searchResult?.searchData?.records || response.data?.records || [];
    expect(records.length, `screener ${screenerId} returned zero records`).toBeGreaterThan(0);

    // Identical fallback chain to etnowScreenerSync.ts's record parsing -- not reimplemented.
    const record = records[0];
    const stockName = record.assetName || record.name || record.companyName || record.stock_name || record.shortName || '';
    const rawSymbol = record.assetSymbol || record.stkId || record.symbol || record.code || record.nseid || '';
    expect(rawSymbol, 'no symbol field found on a real ETnow record').toBeTruthy();
    const nseSymbol = String(rawSymbol).replace(/-NSE$/i, '').replace(/EQ$/i, '').replace(/BE$/i, '').trim();
    expect(nseSymbol.length).toBeGreaterThan(0);
    expect(nseSymbol).not.toMatch(/https?:\/\//);

    const today = new Date().toISOString().slice(0, 10);
    await dbRun(
      `INSERT INTO etnow_screener_stocks (screener_id, symbol, stock_name, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(screener_id, symbol) DO UPDATE SET stock_name = excluded.stock_name, last_seen = excluded.last_seen`,
      [screenerId, nseSymbol, stockName, today, today],
    );

    const written = await dbGet<{ symbol: string; stock_name: string }>(
      `SELECT symbol, stock_name FROM etnow_screener_stocks WHERE screener_id = ? AND symbol = ?`,
      [screenerId, nseSymbol],
    );
    expect(written, 'row not found in etnow_screener_stocks after writing it').toBeTruthy();
    expect(written!.symbol).toBe(nseSymbol);
  }, 30000);
});
