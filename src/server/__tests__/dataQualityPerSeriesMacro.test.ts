import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Audit B-05 (2026-10-08): table-level freshness hid single-series holes.
 *  - macro-asset-prices-freshness reads MAX(date) over the whole table, so it passed through a
 *    22-day NULL ret_5d hole on US10Y/DXY/SP500 (08-06..09-04) -- the inputs the HMM reads.
 *  - market_breadth carried rows on 2026-10-02 (holiday) and 10-04 (Sunday) that the HMM ffills.
 * These run the checks' real SQL against the vitest throwaway schema.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityPerSeriesMacro.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

async function run(id: string) {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === id);
  expect(check, `check ${id} is registered`).toBeDefined();
  const row = await dbGet(check!.sql, check!.params ?? []);
  return check!.evaluate(row as Record<string, any> | undefined, new Date());
}

describe('macro-series-freshness (per series, not per table)', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".macro_asset_prices`);
  });

  async function seed(symbol: string, ret5NullForDays: number) {
    // 30 calendar days of rows up to yesterday; the last `ret5NullForDays` carry ret_5d NULL.
    await dbRun(
      `INSERT INTO "${SCHEMA}".macro_asset_prices (date, symbol, close, ret_5d)
       SELECT CURRENT_DATE - g, ?, 100, CASE WHEN g <= ? THEN NULL ELSE 0.5 END
       FROM generate_series(1, 30) g`,
      [symbol, ret5NullForDays],
    );
  }

  it('passes when every HMM series is fresh', async () => {
    for (const s of ['INDIAVIX', 'US10Y', 'DXY', 'SP500']) await seed(s, 0);
    expect((await run('macro-series-freshness')).status).toBe('pass');
  });

  it('WARNS on a 10-day NULL ret_5d run on DXY although the table MAX(date) is fresh', async () => {
    for (const s of ['INDIAVIX', 'US10Y', 'SP500']) await seed(s, 0);
    await seed('DXY', 10);
    const r = await run('macro-series-freshness');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('DXY');
    // the table-level check cannot see it -- that is the blind spot this closes
    expect((await run('macro-asset-prices-freshness')).status).toBe('pass');
  });

  it('flags a series that is missing entirely', async () => {
    for (const s of ['INDIAVIX', 'US10Y', 'DXY']) await seed(s, 0);
    const r = await run('macro-series-freshness');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('SP500');
  });
});

describe('market-breadth-trading-day', () => {
  // Most recent Sunday, and the Friday before it.
  const SUNDAY = `CURRENT_DATE - EXTRACT(ISODOW FROM CURRENT_DATE)::int`;
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".market_breadth`);
    await dbRun(`DELETE FROM "${SCHEMA}".market_holidays`);
    await dbRun(`INSERT INTO "${SCHEMA}".market_breadth (date, adv_decline_ratio)
                 VALUES (${SUNDAY} - 3, 0.5), (${SUNDAY} - 4, 0.4)`);
  });

  it('passes when every recent row is a session', async () => {
    expect((await run('market-breadth-trading-day')).status).toBe('pass');
  });

  it('warns on a Sunday row', async () => {
    await dbRun(`INSERT INTO "${SCHEMA}".market_breadth (date, adv_decline_ratio) VALUES (${SUNDAY}, 0.2219)`);
    expect((await run('market-breadth-trading-day')).status).toBe('warn');
  });

  it('warns on a known NSE holiday row', async () => {
    await dbRun(`INSERT INTO "${SCHEMA}".market_holidays (date, exchange) VALUES (${SUNDAY} - 2, 'NSE')`);
    await dbRun(`INSERT INTO "${SCHEMA}".market_breadth (date, adv_decline_ratio) VALUES (${SUNDAY} - 2, 0.2219)`);
    expect((await run('market-breadth-trading-day')).status).toBe('warn');
  });
});
