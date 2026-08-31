import { describe, expect, it } from 'vitest';

// Isolates this test from the host environment's USE_POSTGRES -- a deferred `await import`
// (rather than a static top-level import) is required so this runs before any dbAsync.ts import.
const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
const { searchNSEStocksFromDB } = await import('../nseService');

describe('searchNSEStocksFromDB — case-insensitive search', () => {
  // SQLite's LIKE is implicitly ASCII-case-insensitive, so this test alone wouldn't have
  // caught the real bug (LIKE is case-SENSITIVE on Postgres, the platform's live DB) --
  // it pins the LOWER()-wrapped intent so the query stays correct on both dialects.
  it('finds an uppercase-stored symbol when searched in lowercase', async () => {
    await dbExec('DELETE FROM nse_stocks');
    await dbRun(`INSERT INTO nse_stocks (symbol, name, sector, industry, isin, status, last_updated)
       VALUES ('BEL', 'Bharat Electronics Ltd', 'Industrials', 'Defence', 'X', 'ACTIVE', CURRENT_TIMESTAMP)`);

    const rows = await searchNSEStocksFromDB('bel');
    expect(rows.map((r) => r.symbol)).toContain('BEL');
  });

  it('matches a lowercase company-name query against a name stored in mixed case', async () => {
    await dbExec('DELETE FROM nse_stocks');
    await dbRun(`INSERT INTO nse_stocks (symbol, name, sector, industry, isin, status, last_updated)
       VALUES ('INFY', 'Infosys Limited', 'IT', 'Software', 'Y', 'ACTIVE', CURRENT_TIMESTAMP)`);

    const rows = await searchNSEStocksFromDB('infosys');
    expect(rows.map((r) => r.symbol)).toContain('INFY');
  });

  it('ranks an exact symbol match above substring matches from other columns', async () => {
    await dbExec('DELETE FROM nse_stocks');
    await dbRun(`INSERT INTO nse_stocks (symbol, name, sector, industry, isin, status, last_updated)
       VALUES
        ('BEL', 'Bharat Electronics Ltd', 'Industrials', 'Defence', 'X', 'ACTIVE', CURRENT_TIMESTAMP),
        ('ABELCORP', 'A Bel Corp Holdings', 'Industrials', 'Defence', 'Z', 'ACTIVE', CURRENT_TIMESTAMP)`);

    const rows = await searchNSEStocksFromDB('bel');
    expect(rows[0].symbol).toBe('BEL');
  });

  it('excludes non-ACTIVE stocks', async () => {
    await dbExec('DELETE FROM nse_stocks');
    await dbRun(`INSERT INTO nse_stocks (symbol, name, sector, industry, isin, status, last_updated)
       VALUES ('DEAD', 'Delisted Co', 'Industrials', 'Defence', 'X', 'DELISTED', CURRENT_TIMESTAMP)`);

    const rows = await searchNSEStocksFromDB('dead');
    expect(rows.length).toBe(0);
  });
});
