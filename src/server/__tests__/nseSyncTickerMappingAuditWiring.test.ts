import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const SYNC = readFileSync(resolve(ROOT, 'src/server/jobs/sync.jobs.ts'), 'utf8');
const REGISTRY = readFileSync(resolve(ROOT, 'src/server/jobRegistry.ts'), 'utf8');
const DQ = readFileSync(resolve(ROOT, 'src/server/dataQualityChecks.ts'), 'utf8');

describe('weekly NSE ticker-mapping audit wiring', () => {
  it('runs after NSE and provider mappings in the Saturday master sync', () => {
    const master = SYNC.indexOf("runPython('nse_equity_master_fetcher.py'");
    const providerMapping = SYNC.indexOf("'stock-mapping-sync'");
    const audit = SYNC.indexOf("runPython('nse_symbol_mapping_audit.py', [], 180_000)");
    expect(master).toBeGreaterThan(-1);
    expect(providerMapping).toBeGreaterThan(master);
    expect(audit).toBeGreaterThan(providerMapping);
    expect(REGISTRY).toMatch(/jobName: 'nse-sync'[\s\S]{0,150}cronPattern: '0 2 \* \* 6'/);
  });

  it('registers an outcome/freshness check for the persisted audit watermark', () => {
    expect(DQ).toContain("id: 'nse-ticker-mapping-audit'");
    expect(DQ).toContain("dataset = 'nse_ticker_mapping_audit'");
  });
});
