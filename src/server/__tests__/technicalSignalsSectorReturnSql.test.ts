import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sectorReturnSql } from '../technicalSignalsService';

// AF-20261124-01: the sector-momentum query filtered EVERY stock_ohlcv row through a correlated
// `date = (SELECT ... OFFSET n)`. On 2026-11-24 one backend running it reached 6.1 GB anon RSS (+~4 GB
// swapped) and the 8 GiB TimescaleDB container was OOM-killed mid-ml-daily-ops, failing the three steps
// that were running (technical-scan-eod, technical grid-ensurer, mc_techscanner). The per-sector form
// fetches the prior bar per sector symbol via LATERAL instead.
const SRC = readFileSync(join(__dirname, '..', 'technicalSignalsService.ts'), 'utf8');

describe('sector momentum SQL', () => {
  for (const n of [4, 20] as const) {
    it(`bars-back ${n}: per-symbol LATERAL, no row-wide correlated subplan`, () => {
      const sql = sectorReturnSql(n);
      expect(sql).toMatch(/JOIN LATERAL/i);
      expect(sql).toContain(`OFFSET ${n}`);
      expect(sql).not.toMatch(/o\.date\s*=\s*\(/i);
      expect(sql.match(/\?/g)).toHaveLength(3);
    });
  }
  it('the service no longer inlines the correlated form', () => {
    expect(SRC).not.toMatch(/WHERE\s+symbol\s*=\s*o\.symbol\s+AND\s+date\s*<\s*\?/i);
  });
  it('the service still calls the builder for both horizons (non-vacuity)', () => {
    expect(SRC).toMatch(/sectorReturnSql\(4\)/);
    expect(SRC).toMatch(/sectorReturnSql\(20\)/);
  });
});
