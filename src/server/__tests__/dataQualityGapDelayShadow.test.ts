import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * AF-20261126-15: the gap-up delay shadow arm is only evidence if it keeps accumulating. Pins that
 * ml-daily-ops runs it with --persist and that its freshness check fires on a missing, stale or stuck snapshot.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('dataQualityGapDelayShadow.test.ts runs real SQL and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbGet, dbRun } = await import('../dbAsync');
const { DATA_QUALITY_CHECKS } = await import('../dataQualityChecks');

const check = () => DATA_QUALITY_CHECKS.find(c => c.id === 'gap-up-delay-shadow-freshness')!;
const NOW = new Date('2026-12-04T12:00:00+05:30'); // a Friday
const status = (row: Record<string, any> | undefined) => check().evaluate(row, NOW).status;

describe('gap-up-delay-shadow-freshness', () => {
  it('reads the pending count out of the stored snapshot', async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".app_settings WHERE key = 'gap_up_delay_shadow'`);
    await dbRun(`INSERT INTO "${SCHEMA}".app_settings (key, value, "updatedAt")
                 VALUES ('gap_up_delay_shadow', '{"pending":[{"d":"2026-11-27"},{"d":"2026-11-30"}]}', now())`);
    const row = await dbGet(check().sql, check().params ?? []) as Record<string, any>;
    expect(Number(row.pending)).toBe(2);
    expect(row.last_date).toBeTruthy();
    await dbRun(`DELETE FROM "${SCHEMA}".app_settings WHERE key = 'gap_up_delay_shadow'`);
  });

  it('warns when the arm has never written a snapshot', () => {
    expect(status(undefined)).toBe('warn');
  });

  it('passes on a snapshot from the last run', () => {
    expect(status({ last_date: '2026-12-03T19:30:00+05:30', pending: 0 })).toBe('pass');
  });

  it('fails once the arm has stopped accumulating', () => {
    expect(status({ last_date: '2026-11-20T19:30:00+05:30', pending: 0 })).toBe('fail');
  });

  it('warns when days are stuck pending although the snapshot is fresh', () => {
    expect(status({ last_date: '2026-12-03T19:30:00+05:30', pending: 3 })).toBe('warn');
  });

  it('ml-daily-ops runs the arm with --persist and records its failure', () => {
    const queues = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(queues).toMatch(
      /await runPython\('gap_up_delay_shadow\.py', \['--persist'\], [^)]*\)\n\s*\.catch\(e => T\.fail\('gap_up_delay_shadow', e\)\);/,
    );
  });
});
