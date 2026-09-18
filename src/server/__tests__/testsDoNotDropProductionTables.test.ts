/**
 * A test that issues DROP TABLE on an unqualified name must prove it is inside the throwaway
 * schema first (AF-20260917-19).
 *
 * This is not hypothetical. `signalAccuracyDigest.test.ts` opened with
 * `process.env.DATABASE_URL = ':memory:'` -- a SQLite-era line that stopped meaning anything when
 * the SQLite path was deleted on 2026-08-19 -- and then ran
 * `DROP TABLE IF EXISTS high_flyer_daily_stats` / `high_flyer_retrospective` through dbAsync.
 * Both tables were found missing from live Postgres on 2026-09-17, while
 * `high_flyer_candidates` -- created by the same Python script, in the same DDL block, but never
 * named in any test -- was still there. The whole high-flyer subsystem had been dead long enough
 * that no `%flyer%` job had recorded a run in 21 days.
 *
 * `pgClient.getPool()` pins search_path to `"<throwaway>",public`. As AF-20260917-11 established
 * on the pytest side, being FIRST on the path only protects a name the throwaway schema actually
 * has -- and it protects nothing at all when VITEST_PG_SCHEMA is unset, which is every run
 * outside the `unit` project, including a developer running one file by hand.
 *
 * Immunizes by scanning source, not by an allowlist, so a NEW test that drops tables fails here
 * rather than silently deleting production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const TESTS_DIR = path.resolve(__dirname);
const GUARD = 'VITEST_PG_SCHEMA';

function testFiles(): string[] {
  return readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts'));
}

describe('tests must not be able to drop production tables', () => {
  it('every test issuing DROP TABLE asserts it is inside the throwaway schema', () => {
    const offenders: string[] = [];

    for (const file of testFiles()) {
      const src = readFileSync(path.join(TESTS_DIR, file), 'utf8');
      const lines = src.split('\n');

      const drops = lines
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        // Only statements actually sent to the DB. A DROP inside a string being asserted on
        // (pgClient.test.ts checks that alterMigrationName REJECTS one) is not an execution.
        .filter(({ line }) => /\b(dbRun|dbAll|dbGet|execute|query)\s*\(/.test(line))
        .filter(({ line }) => /\bDROP\s+TABLE\b/i.test(line));

      if (drops.length === 0) continue;
      if (src.includes(GUARD)) continue;

      offenders.push(
        `${file}: ${drops.map((d) => `L${d.n}`).join(', ')} issue DROP TABLE without a ${GUARD} guard`
      );
    }

    expect(
      offenders,
      'A test issues DROP TABLE without first proving VITEST_PG_SCHEMA is set. Outside the ' +
      'vitest `unit` project there is no throwaway schema, so an unqualified name resolves to ' +
      'PRODUCTION public and the table is really deleted (AF-20260917-19).'
    ).toEqual([]);
  });

  it('the scan is not vacuous: it still sees the file that caused this', () => {
    // If signalAccuracyDigest.test.ts stops dropping tables the assertion below should be
    // deleted along with this test -- but it must never pass by silently matching nothing.
    const src = readFileSync(path.join(TESTS_DIR, 'signalAccuracyDigest.test.ts'), 'utf8');
    expect(/\bdbRun\s*\(\s*['"]DROP TABLE/i.test(src)).toBe(true);
    expect(src.includes(GUARD)).toBe(true);
  });
});
