import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the 2026-08-07 dead-column fix: historical_fundamentals.net_margin had
 * zero writers (confirmed live, 62,240/62,240 rows null) despite the value being a one-line
 * read away from data already fetched (Yahoo's financialData.profitMargins, fetched for every
 * Phase2 symbol but never consumed). Source-inspection style (matching this session's other
 * wiring tests) since fetchPhase2Data/writePhase2Batch aren't exported for direct unit testing.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'fundamentalsSyncService.ts'), 'utf8');

describe('fundamentalsSyncService net_margin wiring', () => {
  it('reads profitMargins from the Yahoo financialData response', () => {
    expect(SOURCE).toMatch(/netMargin:\s*fd\.profitMargins\?\.raw\s*\?\?\s*null/);
  });

  it('Phase2Row carries netMargin', () => {
    const ifaceMatch = SOURCE.match(/interface Phase2Row \{[^}]*\}/);
    expect(ifaceMatch).not.toBeNull();
    expect(ifaceMatch![0]).toMatch(/netMargin:\s*number \| null/);
  });

  it('UPSERT_HISTORICAL_PHASE2_SQL includes net_margin as a real column, not just a comment', () => {
    const sqlMatch = SOURCE.match(/UPSERT_HISTORICAL_PHASE2_SQL = `([^`]*)`/);
    expect(sqlMatch).not.toBeNull();
    const sql = sqlMatch![1];
    expect(sql).toMatch(/net_margin/);
    expect(sql).toMatch(/net_margin\s*=\s*excluded\.net_margin/);
  });

  it('the write call passes row.netMargin as the last positional param, matching the SQL column order', () => {
    const callMatch = SOURCE.match(/tx\.run\(UPSERT_HISTORICAL_PHASE2_SQL, \[([^\]]*)\]/);
    expect(callMatch).not.toBeNull();
    const params = callMatch![1].split(',').map(s => s.trim()).filter(Boolean);
    expect(params[params.length - 1]).toBe('row.netMargin');
  });

  it('does NOT attempt to populate roce (documented as needing a different Yahoo module, already covered elsewhere)', () => {
    const sqlMatch = SOURCE.match(/UPSERT_HISTORICAL_PHASE2_SQL = `([^`]*)`/);
    expect(sqlMatch![1]).not.toMatch(/\broce\b/);
  });
});
