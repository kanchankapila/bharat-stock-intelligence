import { describe, it, expect, beforeEach } from 'vitest';

/**
 * `ohlcv-fabricated-session` (AF-20261117-18): the check only knew the flat zero-volume shape of a
 * fabricated session. Saturday 2026-07-11 was the other shape -- 2,114 of 2,121 bars repeating the
 * symbol's previous bar exactly, volume included -- and stayed unflagged for four months. Runs the
 * check's real SQL against the vitest throwaway schema.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityCopiedSession.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

async function run() {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === 'ohlcv-fabricated-session')!;
  const row = await dbGet(check.sql, check.params ?? []);
  return check.evaluate(row as Record<string, any> | undefined, new Date());
}

async function seed(copies: number, suspect = 0) {
  const values: string[] = [];
  for (let i = 0; i < 60; i++) {
    const px = 100 + i;
    values.push(`('CPY${i}', current_date - 30, ${px}, ${px * 1.02}, ${px * 0.98}, ${px * 1.01}, ${5000 + i}, 0)`);
    const next = i < copies
      ? `${px}, ${px * 1.02}, ${px * 0.98}, ${px * 1.01}, ${5000 + i}`
      : `${px * 1.01}, ${px * 1.03}, ${px * 0.99}, ${px * 1.02}, ${7000 + i}`;
    values.push(`('CPY${i}', current_date - 29, ${next}, ${suspect})`);
  }
  await dbRun(`INSERT INTO "${SCHEMA}".stock_ohlcv (symbol, date, open, high, low, close, volume, is_suspect)
               VALUES ${values.join(', ')}`);
}

describe('ohlcv-fabricated-session: copied-session shape', () => {
  beforeEach(async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".stock_ohlcv (
      symbol TEXT NOT NULL, date DATE NOT NULL, open DOUBLE PRECISION, high DOUBLE PRECISION,
      low DOUBLE PRECISION, close DOUBLE PRECISION, volume BIGINT, is_suspect SMALLINT DEFAULT 0,
      suspect_reason TEXT, PRIMARY KEY (symbol, date))`);
    await dbRun(`DELETE FROM "${SCHEMA}".stock_ohlcv WHERE date >= current_date - 120`);
  });

  it('fails on an unflagged session that copies the previous bar for the whole universe', async () => {
    await seed(60);
    expect((await run()).status).toBe('fail');
  });

  it('passes a real session where a few illiquid names did not move', async () => {
    await seed(10);
    expect((await run()).status).toBe('pass');
  });

  it('passes once the copied session is flagged is_suspect', async () => {
    await seed(60, 1);
    expect((await run()).status).toBe('pass');
  });
});
