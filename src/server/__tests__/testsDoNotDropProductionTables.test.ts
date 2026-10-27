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

function dropStatements(src: string) {
  return src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    // Transaction handles execute the same SQL as the standalone facade.
    .filter(({ line }) => /\b(dbRun|dbAll|dbGet|dbExec|execute|query)\s*\(|\.\s*(run|exec)\s*\(/.test(line))
    .filter(({ line }) => /\bDROP\s+TABLE\b/i.test(line));
}

describe('tests must not be able to drop production tables', () => {
  it('every test issuing DROP TABLE asserts it is inside the throwaway schema', () => {
    const offenders: string[] = [];

    for (const file of testFiles()) {
      const src = readFileSync(path.join(TESTS_DIR, file), 'utf8');
      const drops = dropStatements(src);

      if (drops.length === 0) continue;

      // A guard that proves the throwaway schema exists is NOT enough: an unqualified
      // `DROP TABLE x` resolves through search_path "<throwaway>",public to the first schema that
      // HAS x, so a missing throwaway copy sends the drop to PRODUCTION. This happened a second
      // time on 2026-10-04 (AF-20261004-02) with the guard in place. Require the target to be
      // schema-qualified (`"${schema}".x` or `schema.x`) as well as the guard.
      const unqualified = drops.filter(
        (d) => !/\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?("?\$\{[^}]+\}"?|"?\w+"?)\./i.test(d.line)
      );
      if (unqualified.length) {
        offenders.push(
          `${file}: ${unqualified.map((d) => `L${d.n}`).join(', ')} DROP TABLE on an unqualified name`
        );
      }
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
    expect(dropStatements(src).length).toBeGreaterThan(0);
    expect(src.includes(GUARD)).toBe(true);
  });

  it.each(['dbRun', 'dbExec', 'tx.run', 'tx.exec', 'client.query'])(
    'recognizes unsafe drops through %s rather than silently ignoring them', call => {
      expect(dropStatements(`await ${call}('DROP TABLE victim')`)).toHaveLength(1);
      expect(dropStatements(`await ${call}('SELECT 1')`)).toEqual([]);
    },
  );

  it('does not treat a rejected SQL argument as a database execution', () => {
    expect(dropStatements("expect(() => alterMigrationName('DROP TABLE foo')).toThrow()")).toEqual([]);
  });
});
