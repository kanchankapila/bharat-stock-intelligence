import { describe, it, expect, beforeEach } from 'vitest';

/**
 * `calibration-shadow-integrity` (AF-20261029-02): a frozen shadow prediction is retroactive only if
 * it was fitted at or after the next session's 09:15 IST open. A wall-clock "same IST date" rule
 * flagged every row written by an ml-daily-ops run that finished after midnight. Runs the check's
 * real SQL against the vitest throwaway schema.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityCalibrationShadow.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

async function run() {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === 'calibration-shadow-integrity')!;
  const row = await dbGet(check.sql, check.params ?? []);
  return check.evaluate(row as Record<string, any> | undefined, new Date());
}

// Monday of last week, so every fitted_at below sits inside the check's 30-day window.
const MON = `(date_trunc('week', current_date)::date - 7)`;

async function seed(dateSql: string, fittedIst: string) {
  await dbRun(
    `INSERT INTO "${SCHEMA}".calibration_shadow (symbol, date, horizon_days, prob, fit_max, fitted_at)
     VALUES ('PROBE', ${dateSql}, 1, 0.4, '2026-01-01', ${fittedIst} AT TIME ZONE 'Asia/Kolkata')`);
}

describe('calibration-shadow-integrity', () => {
  beforeEach(async () => {
    await dbRun(`CREATE TABLE IF NOT EXISTS "${SCHEMA}".calibration_shadow (
      symbol TEXT NOT NULL, date DATE NOT NULL, horizon_days INTEGER NOT NULL,
      prob DOUBLE PRECISION NOT NULL, fit_max TEXT NOT NULL,
      fitted_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (symbol, date, horizon_days))`);
    await dbRun(`DELETE FROM "${SCHEMA}".calibration_shadow`);
  });

  it('accepts a prediction frozen after midnight but before the next open', async () => {
    await seed(MON, `((${MON} + 1) + TIME '02:30')`);
    expect((await run()).status).toBe('pass');
  });

  it('accepts a Friday prediction frozen on Saturday', async () => {
    await seed(`(${MON} + 4)`, `((${MON} + 5) + TIME '11:00')`);
    expect((await run()).status).toBe('pass');
  });

  it('fails a prediction frozen after the next session opened', async () => {
    await seed(MON, `((${MON} + 1) + TIME '09:20')`);
    expect((await run()).status).toBe('fail');
  });
});
