import { describe, it, expect, beforeEach } from 'vitest';

/**
 * AF-20261008-46: `unified-signals-expiry-overdue` failed every weekday between ~16:04 and ~16:28 IST
 * (11 fails since 2026-10-08, 525-590 signals each) and passed once the closer ran at 16:30 IST.
 * The day's bar is persisted ~16:00, which advances the session cutoff by one session 30 minutes
 * before the closer's slot, so the oldest daily cohort reads "overdue" for half an hour. The check
 * must not count a session the closer has not yet had its slot for, but must still fail when the
 * closer is genuinely broken (the same rows overdue against yesterday's cutoff, or still overdue
 * after the slot).
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityExpiryOverdueTiming.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun, dbGet } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

const check = () => {
  const c = DATA_QUALITY_CHECKS.find(x => x.id === 'unified-signals-expiry-overdue');
  expect(c, 'check is registered').toBeDefined();
  return c!;
};

// IST wall-clock instants on a fixed weekday (the clock rule reads only the IST time of day)
const IST = (hh: number, mm: number) => new Date(Date.UTC(2026, 9, 15, hh - 5, mm - 30));

describe('unified-signals-expiry-overdue timing around the closer slot', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".stock_ohlcv`);
    await dbRun(`DELETE FROM "${SCHEMA}".unified_signals`);
  });

  it('evaluate: a cohort that only became overdue when today\'s bar landed is not a failure before the slot', () => {
    const row = { overdue: 525, overdue_pre_close: 0 };
    expect(check().evaluate(row, IST(16, 10)).status).toBe('pass');
    expect(check().evaluate(row, IST(16, 28)).status).toBe('pass');
  });

  it('evaluate: after the slot plus grace the same row IS a failure (the closer did not run)', () => {
    const row = { overdue: 525, overdue_pre_close: 0 };
    expect(check().evaluate(row, IST(17, 5)).status).toBe('fail');
    expect(check().evaluate(row, IST(21, 0)).status).toBe('fail');
  });

  it('evaluate: rows already overdue against yesterday\'s cutoff fail even before the slot', () => {
    const row = { overdue: 1200, overdue_pre_close: 700 };
    expect(check().evaluate(row, IST(16, 10)).status).toBe('fail');
  });

  it('sql: returns both counts and excludes today\'s session from the pre-close one', async () => {
    // 20 sessions ending TODAY (today's bar persisted); one ACTIVE technical signal dated 15 sessions
    // ago: overdue against the cutoff that includes today, not overdue against yesterday's.
    await dbRun(
      `INSERT INTO "${SCHEMA}".stock_ohlcv (symbol, date, open, high, low, close, volume)
       SELECT 'ZZTEST', (now() AT TIME ZONE 'Asia/Kolkata')::date - g, 10, 10, 10, 10, 1000 FROM generate_series(0, 19) g`);
    await dbRun(
      `INSERT INTO "${SCHEMA}".unified_signals (symbol, signal_date, signal_generated_at, signal_source, signal_type, status)
       VALUES ('ZZTEST', ((now() AT TIME ZONE 'Asia/Kolkata')::date - 15)::timestamp AT TIME ZONE 'Asia/Kolkata' + interval '12 hours', now(), 'technical', 'Bullish', 'ACTIVE')`);
    const row = await dbGet(check().sql, check().params ?? []) as Record<string, unknown>;
    expect(Number(row.overdue)).toBe(1);
    expect(Number(row.overdue_pre_close)).toBe(0);
  });
});
