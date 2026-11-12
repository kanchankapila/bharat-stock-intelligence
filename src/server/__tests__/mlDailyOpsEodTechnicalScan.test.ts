import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 2026-11-12: the scheduled technical scan runs every 30 min from 08:30 to 16:00 IST and its 16:00
 * slot is skipped by isMarketOpen(), so no scan ever read the day's final bar (written 16:00 IST)
 * before the 22:30 ranker. The ranker's only technical spread (the pattern-fired rows) therefore
 * came from the previous session's bar. ml-daily-ops (18:50 IST, after the EOD bar) must scan the
 * final bar BEFORE the grid-ensurer, whose ON CONFLICT DO NOTHING would otherwise keep any row a
 * scan had not refreshed.
 */
describe('ml-daily-ops scans the final bar before the technical grid-ensurer', () => {
  const src = readFileSync(join(__dirname, '..', 'queues.ts'), 'utf8');
  const start = src.indexOf('async function processMlDailyOps(');
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  const body = src.slice(start, start + 1 + (end < 0 ? rest.length : end));

  it('calls runTechnicalSignalScan inside processMlDailyOps', () => {
    expect(body.indexOf('runTechnicalSignalScan(')).toBeGreaterThan(0);
  });

  it('the scan runs before backfill_technical_features.py --full-today', () => {
    const scan = body.indexOf('runTechnicalSignalScan(');
    const grid = body.indexOf("runPython('backfill_technical_features.py', ['--full-today']");
    expect(grid).toBeGreaterThan(0);
    expect(scan).toBeGreaterThan(0);
    expect(scan).toBeLessThan(grid);
  });

  it('a scan failure is recorded on the job, never swallowed', () => {
    const scan = body.indexOf('runTechnicalSignalScan(');
    expect(body.slice(scan, scan + 200)).toMatch(/T\.fail\('technical-scan-eod'/);
  });
});
