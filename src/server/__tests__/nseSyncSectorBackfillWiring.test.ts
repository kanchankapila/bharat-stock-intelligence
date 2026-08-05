import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the 2026-08-05 sector-backfill fix.
 *
 * backfill_sectors.py alone was a structural no-op for ~95% of the universe -- its only
 * source (confluence_signals.sector) is itself populated from nse_stocks.sector, so it can
 * never create a classification that didn't already exist. backfill_sector_mc.py (an
 * independent MoneyControl-sourced backfill) is the one that actually creates new
 * classifications, and must run BEFORE backfill_sectors.py so that step's propagation into
 * recommendation_log/unified_signals/signals picks up the freshest data, not a stale/absent
 * one. This locks in both the ordering and that the job's lockDuration was widened to cover
 * the new step's measured (~9-10 min live) runtime.
 */
const SOURCE = readFileSync(
  join(__dirname, '..', 'jobs', 'sync.jobs.ts'),
  'utf8',
);

describe('nse-sync-weekly sector backfill wiring', () => {
  it('calls backfill_sector_mc.py with --enumerate and --write', () => {
    expect(SOURCE).toMatch(/backfill_sector_mc\.py['"],\s*\[['"]--enumerate['"],\s*['"]--write['"]/);
  });

  it('runs backfill_sector_mc.py before backfill_sectors.py (real source before its propagator)', () => {
    const mcIdx = SOURCE.indexOf('backfill_sector_mc.py');
    const propagateIdx = SOURCE.indexOf("runPython('backfill_sectors.py'");
    expect(mcIdx).toBeGreaterThan(-1);
    expect(propagateIdx).toBeGreaterThan(-1);
    expect(mcIdx).toBeLessThan(propagateIdx);
  });

  it('calls the exported syncMappings() from syncAllStockMappings.ts (provider-mapping backfill)', () => {
    // 544/2366 ACTIVE symbols were missing mcsymbol/tlid entirely and the only fix (npm run
    // sync:mappings) was manual-only -- never scheduled, so newly-added nse_stocks rows
    // accumulated with no provider mapping forever. Must be imported (not shelled out to),
    // matching syncNSEStocksToDatabase's own call style directly above it.
    expect(SOURCE).toMatch(/import\(['"]\.\.\/\.\.\/\.\.\/scripts\/syncAllStockMappings['"]\)/);
    expect(SOURCE).toMatch(/syncMappings\(\)/);
  });

  it("nse-sync-weekly's lockDuration covers the new step's runPython timeout with margin", () => {
    const mcCallMatch = SOURCE.match(/backfill_sector_mc\.py['"],\s*\[[^\]]*\],\s*([\d_]+)/);
    expect(mcCallMatch).not.toBeNull();
    const mcTimeoutMs = Number(mcCallMatch![1].replace(/_/g, ''));
    expect(mcTimeoutMs).toBeGreaterThanOrEqual(900_000); // measured ~9-10 min live

    const nseSyncBlock = SOURCE.slice(SOURCE.indexOf("jobName: 'nse-sync-weekly'"));
    const lockMatch = nseSyncBlock.match(/lockDuration:\s*([^,]+),/);
    expect(lockMatch).not.toBeNull();
    // eslint-disable-next-line no-eval
    const lockDurationMs = eval(lockMatch![1].trim());
    expect(lockDurationMs).toBeGreaterThan(mcTimeoutMs); // real margin above the single biggest step
  });
});
