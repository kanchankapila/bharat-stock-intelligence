// Pins that all FOUR screener syncs record appeared_at.
//
// It said "three" and listed three until 2026-08-12, when trendlyneScreener.ts -- the LARGEST
// writer, 435,700 of the table's 741,251 rows -- turned out to be the one omitted. Only 10 rows
// platform-wide had appeared_at set. An enumerated allowlist silently stops covering whatever
// nobody remembered to add, which is the same class as the "grep EVERY reader of the table"
// lesson in recurring-bugs.md. Hence the completeness check at the bottom of this file: it
// derives the writer list from the source tree instead of trusting this constant.
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const SYNCS = [
  ['etnowScreenerSync.ts', "'etnow'"],
  ['moneycontrolScreener.ts', "'moneycontrol'"],
  ['etMarketstatsSync.ts', "'et_marketstats'"],
  ['trendlyneScreener.ts', "'trendlyne'"],
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

  it('SYNCS covers EVERY file that writes screener_appearances (derived, not hand-listed)', () => {
    // The check that would have caught trendlyneScreener.ts on day one. Scans the server source
    // for the INSERT rather than trusting SYNCS, so adding a 5th provider fails here until it is
    // added above -- instead of silently writing NULL appeared_at forever.
    const dir = join(__dirname, '..');
    const writers = readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .filter(f => readFileSync(join(dir, f), 'utf8')
        .includes('INSERT OR IGNORE INTO screener_appearances'));
    expect(writers.length).toBeGreaterThan(0);         // guards against the scan silently matching nothing
    expect(writers.sort()).toEqual(SYNCS.map(([f]) => f).sort());
  });

  // Only the Postgres snapshot is asserted now. This used to also check db.ts's SQLite
  // schema-of-record; that file was renamed to db.sqlite-legacy.ts and unwired by
  // SQLITE_DECOMMISSION_PLAN Phase 3, and asserting a retired file still declares a column is
  // exactly the kind of stale guard this suite exists to avoid -- db/schema.postgres.sql is
  // generated from live and is the only authoritative schema.
  it('the column is in the Postgres schema snapshot', () => {
    const pg = readFileSync(join(__dirname, '..', '..', '..', 'db', 'schema.postgres.sql'), 'utf8');
    expect(pg).toContain('"appeared_at" TIMESTAMPTZ');
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
