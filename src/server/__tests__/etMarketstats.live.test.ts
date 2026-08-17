/**
 * LIVE DATASOURCE TEST — skipped by default, opt in with RUN_LIVE_DATASOURCE_TESTS=1.
 *
 * etMarketstats.ts had no live-hitting test before this file (data-coverage-audit, 2026-08-13
 * TS-side sweep). Uses its own resolution (getEtMarketstatsScreenerDefs() -- the real, already-
 * seeded screener catalog, not a hardcoded viewId) to pick ONE real screener, fetches it via
 * the fetcher's own fetchEtMarketstatsScreener(), parses with its own extractMetricRows(), and
 * persists via the exact INSERT shape etMarketstatsSync.ts's buildMetricUpsertSql uses (that
 * function itself isn't exported, so this mirrors its literal SQL rather than reimplementing
 * any FETCH/PARSE logic -- the class of bug this mandate exists to catch). No cleanup: this
 * writes genuine production-shaped rows into mc_general_metrics, identical to what the real
 * nightly sync would write for this screener.
 *
 *   RUN_LIVE_DATASOURCE_TESTS=1 npx vitest run src/server/__tests__/etMarketstats.live.test.ts
  *
 * LIVE_DATE_SAFE: writes mc_general_metrics, which has no trading-date key; only a fetched_at timestamp, and "fetched on a Saturday" is a true statement.
 * (Declared for liveTestTradingDayGuard.test.ts -- see it for why this must be stated.)
*/
import { describe, it, expect, beforeAll } from 'vitest';
import type { EtMarketstatsScreenerDef } from '../etMarketstats';

// Gated behind RUN_LIVE, not a static top-level `import 'dotenv/config'` -- that would load
// real credentials into process.env on EVERY vitest run (all test files share one process),
// including runs where this suite is skipped. Found live 2026-08-13: it broke
// niftytraderAuthService.test.ts's "no credentials configured" case by leaking a real
// NIFTYTRADER_EMAIL/PASSWORD into env for the whole worker. RUN_LIVE_DATASOURCE_TESTS itself
// is a plain shell env var, not something .env provides, so checking it first is safe.
const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';
if (RUN_LIVE) await import('dotenv/config');

const { getEtMarketstatsScreenerDefs, fetchEtMarketstatsScreener, extractMetricRows, cleanNseSymbol } =
  await import('../etMarketstats');
const { dbRun, dbGet } = await import('../dbAsync');

describe.runIf(RUN_LIVE)('etMarketstats [live]', () => {
  let def: EtMarketstatsScreenerDef;

  beforeAll(async () => {
    const defs = await getEtMarketstatsScreenerDefs();
    if (defs.length === 0) {
      throw new Error('et_marketstats_screeners is empty -- run initEtMarketstatsScreeners() first');
    }
    def = defs[0];
  });

  it('fetches a real ET Marketstats screener and persists ML-usable metric rows', async () => {
    const response = await fetchEtMarketstatsScreener(def);
    expect(response.dataList, `no dataList for screener "${def.label}"`).toBeTruthy();
    expect(response.dataList.length, `screener "${def.label}" returned zero records`).toBeGreaterThan(0);

    const record = response.dataList[0];
    const symbol = cleanNseSymbol(record.assetSymbol);
    expect(symbol.length).toBeGreaterThan(0);

    const fetchedAt = new Date().toISOString();
    const rows = extractMetricRows(def, symbol, record, fetchedAt);
    expect(rows.length, 'extractMetricRows produced no rows for a real record').toBeGreaterThan(0);

    // Matches etMarketstatsSync.ts's buildMetricUpsertSql exactly (not exported to import).
    for (const [sym, sourceApi, metricGroup, metricName, valNum, valText, fa] of rows) {
      await dbRun(
        `INSERT INTO mc_general_metrics
           (symbol, source_api, metric_group, metric_name, metric_value_num, metric_value_text, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, source_api, metric_group, metric_name, fetched_at) DO UPDATE SET
           metric_value_num = excluded.metric_value_num, metric_value_text = excluded.metric_value_text`,
        [sym, sourceApi, metricGroup, metricName, valNum, valText, fa],
      );
    }

    const [firstRow] = rows;
    const written = await dbGet<{ symbol: string; metric_value_num: number | null; metric_value_text: string | null }>(
      `SELECT symbol, metric_value_num, metric_value_text FROM mc_general_metrics
       WHERE symbol = ? AND source_api = 'et_marketstats' AND metric_group = ? AND metric_name = ? AND fetched_at = ?`,
      [firstRow[0], firstRow[2], firstRow[3], fetchedAt],
    );
    expect(written, 'row not found in mc_general_metrics after writing it').toBeTruthy();
    expect(written!.symbol).toBe(symbol);
    // identifier looks like a ticker, not a URL/scrape artifact
    expect(written!.symbol).not.toMatch(/https?:\/\//);
    // exactly one of num/text should be set (parseMetricField's own invariant)
    expect(written!.metric_value_num === null || written!.metric_value_text === null).toBe(true);
    if (written!.metric_value_num !== null) {
      expect(Number.isFinite(written!.metric_value_num)).toBe(true);
    }
  }, 30000);
});
