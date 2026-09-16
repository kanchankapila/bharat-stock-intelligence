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
  it('calls backfill_sector_mc.py as TWO independent steps: --enumerate then --write', () => {
    // Split 2026-09-12 (AF-20260912-16). Both phases shared one 900s budget while the enumerate
    // alone measures ~895s, so when it ran long the kill landed on the WRITE -- the only phase
    // that touches the DB. Measured on the 09-12 07:45 failure: mc_sector_cache.json was
    // COMPLETE (2,340 symbols, 2,174 with a sector) at 07:44:56 and the process died at
    // 07:45:00, so 15 minutes of MoneyControl traffic was discarded for want of ten seconds
    // (the write, timed live, takes 10s). --write reads only that cache, which
    // enumerate_sectors() flushes every 200 symbols and again at the end.
    expect(SOURCE).toMatch(/backfill_sector_mc\.py['"],\s*\[['"]--enumerate['"]\]/);
    expect(SOURCE).toMatch(/backfill_sector_mc\.py['"],\s*\[['"]--write['"]/);
  });

  it('the --write step is not gated on --enumerate succeeding', () => {
    // The entire point of the split: each step carries its own .catch(), so a timed-out
    // enumerate is recorded as a step failure and execution still reaches the write.
    // Without this, the split is cosmetic and the old failure returns.
    const enumIdx = SOURCE.indexOf("['--enumerate']");
    const writeIdx = SOURCE.indexOf("['--write', '--report-unmapped']");
    expect(enumIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(enumIdx);
    expect(SOURCE.slice(enumIdx, writeIdx)).toMatch(/\.catch\(/);
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

    // The lock must clear the SUM of the processor's steps, not just its largest one -- a job
    // is reclaimed as stalled based on total elapsed time. Asserting only against the biggest
    // step is what let this drift: the lock's own comment budgeted "backfill_sectors.py (120s)"
    // but that step was raised to 600s on 2026-09-05 and index_membership to 180s, leaving a
    // 20-min lock over ~35 min of budgets with nothing to catch it (AF-20260912-16).
    const procStart = SOURCE.indexOf('async function processNSESync');
    expect(procStart).toBeGreaterThan(-1);
    const procBody = SOURCE.slice(procStart, SOURCE.indexOf("jobName: 'nse-sync-weekly'"));
    const budgets = [...procBody.matchAll(/runPython\([^)]*?,\s*([\d_]+(?:\s*\*\s*[\d_]+)*)\s*\)/g)]
      // eslint-disable-next-line no-eval
      .map(m => eval(m[1].replace(/_/g, '')) as number);
    expect(budgets.length).toBeGreaterThan(2); // non-vacuity: the scan actually found steps
    const totalBudgetMs = budgets.reduce((a, b) => a + b, 0);
    expect(lockDurationMs).toBeGreaterThan(totalBudgetMs);
  });
});
