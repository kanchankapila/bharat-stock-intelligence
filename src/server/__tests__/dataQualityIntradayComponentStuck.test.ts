import { describe, it, expect, beforeEach } from 'vitest';

/**
 * `intraday-blend-component-stuck`: a blend component with one distinct value across the universe
 * cannot rank anything. screener_score sat at 50.0 for every symbol from 2026-08-12 and was found
 * on 2026-10-25 (AF-20261025-01); only freshness was monitored. Runs the check's real SQL.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityIntradayComponentStuck.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

const ID = 'intraday-blend-component-stuck';
const DAY = '2026-11-26';

async function run() {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === ID);
  expect(check, `check ${ID} is registered`).toBeDefined();
  const row = await dbGet(check!.sql, check!.params ?? []);
  return check!.evaluate(row as Record<string, any> | undefined, new Date());
}

// 60 symbols; each component is an SQL expression over g (the symbol number).
async function seed(screener: string, breakout: string, reversal: string) {
  await dbRun(
    `INSERT INTO "${SCHEMA}".intraday_recommendations (symbol, computed_at, screener_score, breakout_score)
     SELECT 'S' || g, '${DAY}', ${screener}, ${breakout} FROM generate_series(1, 60) g`);
  await dbRun(
    `INSERT INTO "${SCHEMA}".intraday_recommendations_history (symbol, computed_at, cycle_at, reversal_score)
     SELECT 'S' || g, '${DAY}', '${DAY}T04:00:00', ${reversal} FROM generate_series(1, 60) g`);
}

describe('intraday-blend-component-stuck (read-only)', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".intraday_recommendations`);
    await dbRun(`DELETE FROM "${SCHEMA}".intraday_recommendations_history`);
  });

  it('warns and names the component that has one value for every symbol', async () => {
    await seed('50.0', 'g', 'g');
    const r = await run();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('screener_score is 50 for all 60');
    expect(r.detail).not.toContain('breakout_score is');
  });

  it('passes when every component varies', async () => {
    await seed('g', 'g', 'g');
    expect((await run()).status).toBe('pass');
  });

  it('does not report an unrecorded component as healthy or stuck', async () => {
    await seed('g', 'g', 'NULL::float8');
    const r = await run();
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('not measured: reversal_score');
  });

  it('warns when there is nothing to measure', async () => {
    expect((await run()).status).toBe('warn');
  });
});
