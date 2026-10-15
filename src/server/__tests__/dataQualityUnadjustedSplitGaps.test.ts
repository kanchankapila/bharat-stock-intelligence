import { describe, it, expect, beforeEach } from 'vitest';

/**
 * AF-20261008-41 follow-up: `ohlcv-corporate-action-gap` must name the symbols and the exact
 * repair command, escalate to fail on a cluster, and use repair_unadjusted_splits.py's own
 * definition of a seam (zero-volume bars are synthetic, never a seam). Runs the check's real SQL
 * against the vitest throwaway schema.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityUnadjustedSplitGaps.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

const ID = 'ohlcv-corporate-action-gap';

async function run() {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === ID);
  expect(check, `check ${ID} is registered`).toBeDefined();
  const row = await dbGet(check!.sql, check!.params ?? []);
  return check!.evaluate(row as Record<string, any> | undefined, new Date());
}

// 15 daily bars ending yesterday at 100; from `gapDaysAgo` on the close is 100*ratio.
async function seedBars(symbol: string, gapDaysAgo: number | null, ratio: number, opts: { volume?: number; suspect?: number } = {}) {
  await dbRun(
    `INSERT INTO "${SCHEMA}".stock_ohlcv (symbol, date, open, high, low, close, volume, is_suspect)
     SELECT ?, CURRENT_DATE - g, c, c, c, c, CASE WHEN g = ? THEN ? ELSE 1000 END, CASE WHEN g = ? THEN ? ELSE 0 END
     FROM (SELECT g, CASE WHEN ?::int IS NOT NULL AND g <= ?::int THEN 100 * ?::float8 ELSE 100 END AS c
           FROM generate_series(1, 15) g) s`,
    [symbol, gapDaysAgo ?? -1, opts.volume ?? 1000, gapDaysAgo ?? -1, opts.suspect ?? 0, gapDaysAgo, gapDaysAgo, ratio],
  );
}
async function seedFactor(symbol: string, exDaysAgo: number, factor: number) {
  await dbRun(`INSERT INTO "${SCHEMA}".ohlcv_adjustment_factors (symbol, ex_date, factor) VALUES (?, CURRENT_DATE - ?::int, ?)`,
    [symbol, exDaysAgo, factor]);
}

describe('ohlcv-corporate-action-gap (unadjusted split/bonus gaps, read-only)', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".stock_ohlcv`);
    await dbRun(`DELETE FROM "${SCHEMA}".ohlcv_adjustment_factors`);
  });

  it('a -50% bar next to a 1:2 factor warns and names the symbol plus the dry-run/apply commands', async () => {
    await seedBars('SPLITCO', 3, 0.5);
    await seedFactor('SPLITCO', 2, 0.5);
    const r = await run();
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('SPLITCO');
    expect(r.detail).toContain('python scripts/repair/repair_unadjusted_splits.py');
    expect(r.detail).toContain('--apply --dump-path');
  });

  it('a true -50% crash with no factor passes', async () => {
    await seedBars('CRASHCO', 3, 0.5);
    expect((await run()).status).toBe('pass');
  });

  it('an already-adjusted history (no seam) next to a factor passes', async () => {
    await seedBars('DONECO', null, 1);
    await seedFactor('DONECO', 3, 0.5);
    expect((await run()).status).toBe('pass');
  });

  it('a zero-volume (synthetic) gap bar is not a seam, matching the repair script', async () => {
    await seedBars('ZEROVOL', 3, 0.5, { volume: 0 });
    await seedFactor('ZEROVOL', 3, 0.5);
    // Only the zero-volume bar sits on the new basis's first day; the next traded bar vs its
    // traded predecessor is still a seam, so make the whole new basis start on the zero bar.
    await dbRun(`DELETE FROM "${SCHEMA}".stock_ohlcv WHERE symbol = 'ZEROVOL' AND date > CURRENT_DATE - 3`);
    expect((await run()).status).toBe('pass');
  });

  it('a gap older than the last 10 sessions is out of the verdict window', async () => {
    await seedBars('OLDGAP', 13, 0.5);
    await seedFactor('OLDGAP', 13, 0.5);
    expect((await run()).status).toBe('pass');
  });

  it('five or more gaps fail and the detail lists at most five symbols', async () => {
    for (const s of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
      await seedBars(s, 2, 0.5);
      await seedFactor(s, 2, 0.5);
    }
    const r = await run();
    expect(r.status).toBe('fail');
    const named = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'].filter(s => new RegExp(`\\b${s}\\b`).test(r.detail));
    expect(named.length).toBe(5);
  });

  it('is_suspect bars are excluded', async () => {
    await seedBars('SUSPCO', 3, 0.5, { suspect: 1 });
    await seedFactor('SUSPCO', 3, 0.5);
    await dbRun(`DELETE FROM "${SCHEMA}".stock_ohlcv WHERE symbol = 'SUSPCO' AND date > CURRENT_DATE - 3`);
    expect((await run()).status).toBe('pass');
  });
});
