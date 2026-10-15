import { describe, it, expect, beforeEach } from 'vitest';

/**
 * `ohlcv-unflagged-ghost-bar`: on the latest date whose official bhavcopy is complete, no bar for
 * a real NSE listing may sit unflagged while the file has no row for it (CCAVENUE 2026-10-14:
 * the reconcile quarantine was reset by ohlcv_quality the same night). Runs the check's real SQL
 * against the vitest throwaway schema.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityGhostBars.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

const ID = 'ohlcv-unflagged-ghost-bar';

async function run() {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === ID);
  expect(check, `check ${ID} is registered`).toBeDefined();
  const row = await dbGet(check!.sql, check!.params ?? []);
  return check!.evaluate(row as Record<string, any> | undefined, new Date());
}

// Yesterday's file lists `n` filler symbols plus LIVE; GHOST traded the day before only.
async function seed(n: number, ghostSuspect: number) {
  await dbRun(`INSERT INTO "${SCHEMA}".nse_stocks (symbol, name) VALUES ('GHOST', 'G'), ('LIVE', 'L'), ('ALIAS', 'A') ON CONFLICT DO NOTHING`);
  await dbRun(
    `INSERT INTO "${SCHEMA}".nse_universe_history (date, symbol, series, close)
     SELECT CURRENT_DATE - 1, 'FILL' || g, 'EQ', 1 FROM generate_series(1, ?::int) g`, [n]);
  await dbRun(
    `INSERT INTO "${SCHEMA}".nse_universe_history (date, symbol, series, close)
     VALUES (CURRENT_DATE - 1, 'LIVE', 'EQ', 5), (CURRENT_DATE - 2, 'GHOST', 'EQ', 5)`);
  await dbRun(
    `INSERT INTO "${SCHEMA}".stock_ohlcv (symbol, date, open, high, low, close, volume, is_suspect)
     VALUES ('GHOST', CURRENT_DATE - 1, 5, 5, 5, 5, 100, ?), ('LIVE', CURRENT_DATE - 1, 5, 5, 5, 5, 100, 0),
            ('ALIAS', CURRENT_DATE - 1, 5, 5, 5, 5, 100, 0)`, [ghostSuspect]);
}

describe('ohlcv-unflagged-ghost-bar (read-only)', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".stock_ohlcv`);
    await dbRun(`DELETE FROM "${SCHEMA}".nse_universe_history`);
    await dbRun(`DELETE FROM "${SCHEMA}".nse_stocks WHERE symbol IN ('GHOST', 'LIVE', 'ALIAS')`);
  });

  it('fails on an unflagged bar absent from a complete official file and names the symbol', async () => {
    await seed(1500, 0);
    const r = await run();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('GHOST');
    expect(r.detail).not.toContain('ALIAS');
    expect(r.detail).toContain('scripts/repair/flag_ghost_bars.py');
  });

  it('passes once the ghost is quarantined', async () => {
    await seed(1500, 1);
    expect((await run()).status).toBe('pass');
  });

  it('ignores an incomplete official file', async () => {
    await seed(100, 0);
    expect((await run()).status).toBe('pass');
  });
});
