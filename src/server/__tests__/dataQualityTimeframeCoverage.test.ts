import { describe, it, expect, beforeEach } from 'vitest';

/**
 * `unified-recommendations-timeframe-coverage`: runs the check's real SQL against the vitest
 * throwaway schema with a pinned as-of instant. The trailing set is the distinct non-NULL
 * timeframes over the 10 ranking days (IST dates) before the latest ranking day; a label seen
 * there and absent on the latest day fails, a label outside that window (retired) does not.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityTimeframeCoverage.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

const AS_OF = '2026-10-20T10:00:00+05:30';
const check = () => {
  const c = DATA_QUALITY_CHECKS.find(x => x.id === 'unified-recommendations-timeframe-coverage');
  expect(c, 'unified-recommendations-timeframe-coverage is registered').toBeDefined();
  return c!;
};
async function run() {
  const row = await dbGet<Record<string, any>>(check().sql, [AS_OF]);
  return { row, result: check().evaluate(row, new Date(AS_OF)) };
}
// One ranking row per (day, timeframe), stamped 22:30 IST on `day`; null = a row with no horizon.
async function seed(day: string, timeframes: Array<string | null>) {
  for (const tf of timeframes) {
    await dbRun(
      `INSERT INTO "${SCHEMA}".unified_recommendations (symbol, unified_score, regime, conviction_level, computed_at, timeframe, generated_at)
       VALUES (?, 50, 'neutral', 'medium', ?, ?, CAST(? AS timestamptz))`,
      [`S_${tf ?? 'NULL'}_${day}`, `${day} 22:30`, tf, `${day}T22:30:00+05:30`]);
  }
}
const CANON = ['INTRADAY', 'SWING', 'POSITIONAL'];
const day = (n: number) => new Date(Date.UTC(2026, 9, 19) - n * 86_400_000).toISOString().slice(0, 10);

describe('unified-recommendations-timeframe-coverage (real SQL)', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".unified_recommendations`);
  });

  it('fails naming LONG_TERM when it produced rows in the trailing days and none on the latest ranking day', async () => {
    for (let n = 1; n <= 5; n++) await seed(day(n), [...CANON, 'LONG_TERM', null]);
    await seed(day(0), [...CANON, null]);
    const { row, result } = await run();
    expect(row!.latest_day).toBe(day(0));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('LONG_TERM');
  });

  it('passes when every trailing timeframe is present on the latest day', async () => {
    for (let n = 0; n <= 5; n++) await seed(day(n), [...CANON, 'LONG_TERM']);
    expect((await run()).result.status).toBe('pass');
  });

  it('a timeframe last produced before the 10-ranking-day window is retired, not a failure', async () => {
    await seed(day(30), [...CANON, 'LONG_TERM']);
    for (let n = 0; n <= 11; n++) await seed(day(n), CANON);
    const { row, result } = await run();
    expect(row!.trailing_set).toBe('INTRADAY,POSITIONAL,SWING');
    expect(result.status).toBe('pass');
  });

  it('counts RANKING days, so a stretch with no rankings does not age a timeframe out of the window', async () => {
    await seed(day(14), [...CANON, 'LONG_TERM']);
    await seed(day(0), CANON);
    const { result } = await run();
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('LONG_TERM');
  });

  it('a NULL timeframe is not a label: rows with no horizon neither satisfy nor create a requirement', async () => {
    await seed(day(1), [null]);
    await seed(day(0), [...CANON, null]);
    const { row, result } = await run();
    expect(row!.trailing_set).toBe('');
    expect(result.status).toBe('pass');
  });

  it('uses the IST date: a 22:30 IST ranking and a 03:00 IST ranking the next morning are different days', async () => {
    await seed(day(1), ['SWING', 'POSITIONAL']);
    await dbRun(
      `INSERT INTO "${SCHEMA}".unified_recommendations (symbol, unified_score, regime, conviction_level, computed_at, timeframe, generated_at)
       VALUES ('EARLY', 50, 'neutral', 'medium', 'early', 'SWING', CAST(? AS timestamptz))`, [`${day(0)}T03:00:00+05:30`]);
    const { row, result } = await run();
    expect(row!.latest_day).toBe(day(0));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('POSITIONAL');
  });

  it('a CANONICAL horizon absent from the whole trailing window still fails (a dead horizon never ages out)', async () => {
    for (let n = 0; n <= 12; n++) await seed(day(n), ['SWING', 'POSITIONAL']);
    const { row, result } = await run();
    expect(row!.trailing_set).toBe('POSITIONAL,SWING');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('INTRADAY');
    expect(result.detail).toMatch(/canonical/i);
  });

  it('LONG_TERM (folded onto POSITIONAL, AF-20261001-06) neither fails nor is required once outside the window', async () => {
    await seed(day(20), [...CANON, 'LONG_TERM']);
    for (let n = 0; n <= 11; n++) await seed(day(n), CANON);
    const { result } = await run();
    expect(result.status).toBe('pass');
  });

  it('fails with no evidence when the table has no ranking in the lookback window', async () => {
    const { result } = await run();
    expect(result.status).toBe('fail');
  });
});
