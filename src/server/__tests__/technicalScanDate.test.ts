import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2026-11-12: runTechnicalSignalScan dated its rows by the wall clock while computing them from
 * the latest STORED bar. stock_ohlcv's EOD row lands at 16:00 IST, so every in-session scan
 * filed the previous session's bar under today's date: all 415 scan rows dated 2026-11-11
 * carried the 2026-11-09 close (AUROPHARMA cmp 1855.30 vs the 11-11 close 1827.50), the 18:50
 * grid-ensurer's ON CONFLICT DO NOTHING kept them, and the 22:30 ranker and confluence trade
 * levels read them as the day's technicals. A row's date must be the date of the bar it was
 * computed from.
 */
if (!process.env.VITEST_PG_SCHEMA) {
  throw new Error('technicalScanDate.test.ts writes fixture rows and refuses to run without VITEST_PG_SCHEMA');
}
const SCHEMA = process.env.VITEST_PG_SCHEMA;
const { dbRun } = await import('../dbAsync');
const { resolveScanDate } = await import('../technicalSignalsService');

describe('technical scan date = date of the latest stored bar', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM "${SCHEMA}".stock_ohlcv`);
    await dbRun(`INSERT INTO "${SCHEMA}".stock_ohlcv (symbol, date, open, high, low, close, volume)
                 VALUES ('AAA', '2026-01-06', 10, 11, 9, 10.5, 1000), ('AAA', '2026-01-07', 10.5, 12, 10, 11.5, 1200)`);
  });

  it('a scan with no explicit date is dated by the latest bar, never by the wall clock', async () => {
    expect(await resolveScanDate()).toBe('2026-01-07');
  });

  it('an explicit date (historical rescan) still wins', async () => {
    expect(await resolveScanDate('2026-01-06')).toBe('2026-01-06');
  });

  it('runTechnicalSignalScan resolves its date through resolveScanDate', () => {
    const src = readFileSync(join(__dirname, '..', 'technicalSignalsService.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function runTechnicalSignalScan'));
    expect(body.slice(0, 2500)).toMatch(/const scanDate = await resolveScanDate\(options\.date\)/);
  });
});
