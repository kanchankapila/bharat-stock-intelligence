// Pins that all three screener syncs record appeared_at.
//
// screener_appearances.appeared_date is date-only AND part of the primary key, so it can never
// carry a capture time. appeared_at is the only record of WHEN a screener flagged a symbol, and
// without it the intraday question ("enter at the moment of flagging, exit at the close") is
// unmeasurable -- all 720,824 rows written before 2026-08-11 are stamped 00:00:00.
//
// A source-level check on purpose: these functions each hit a live third-party API and write
// through dbTransaction, so exercising them properly needs network + a DB. The failure this
// guards against is someone editing one INSERT and not the other two, which a text check catches
// exactly as well as an integration test would.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SYNCS = [
  ['etnowScreenerSync.ts', "'etnow'"],
  ['moneycontrolScreener.ts', "'moneycontrol'"],
  ['etMarketstatsSync.ts', "'et_marketstats'"],
] as const;

const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

describe('screener_appearances.appeared_at', () => {
  for (const [file, source] of SYNCS) {
    it(`${file} inserts appeared_at alongside appeared_date`, () => {
      const src = read(file);
      const insert = src
        .split('\n')
        .find(l => l.includes('INSERT OR IGNORE INTO screener_appearances'));
      expect(insert, `no screener_appearances INSERT found in ${file}`).toBeDefined();
      expect(insert).toContain('appeared_date, appeared_at');
      expect(insert).toContain(source);
    });

    it(`${file} passes a real timestamp, not a date`, () => {
      const src = read(file);
      // toISOString() keeps the time; a bare date string would silently reintroduce the bug.
      expect(src).toMatch(/new Date\(\)\.toISOString\(\)/);
    });
  }

  it('the column is in the Postgres schema snapshot and the SQLite schema-of-record', () => {
    const pg = readFileSync(join(__dirname, '..', '..', '..', 'db', 'schema.postgres.sql'), 'utf8');
    expect(pg).toContain('"appeared_at" TIMESTAMPTZ');
    const dbTs = read('db.ts');
    expect(dbTs).toContain('079_screener_appearances_appeared_at');
  });

  it('appeared_at is NOT part of the primary key', () => {
    // Putting it in the key would stop a repeat same-day appearance from deduping and would
    // multiply the table by the sync frequency -- the reason it is a separate column at all.
    const pg = readFileSync(join(__dirname, '..', '..', '..', 'db', 'schema.postgres.sql'), 'utf8');
    const tbl = pg.slice(pg.indexOf('CREATE TABLE IF NOT EXISTS "screener_appearances"'));
    const pk = tbl.slice(tbl.indexOf('PRIMARY KEY'), tbl.indexOf(');'));
    expect(pk).toContain('"screener_id", "symbol", "appeared_date"');
    expect(pk).not.toContain('appeared_at');
  });
});
