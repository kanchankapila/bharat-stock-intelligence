import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { usePostgres } from '../pgConfig';

/**
 * TypeScript half of the Postgres-only guarantee (2026-08-15). Python half:
 * src/server/tests/test_sql_translate.py.
 *
 * `usePostgres()` used to be `process.env.USE_POSTGRES === 'true'` — SQLite by default. That
 * default silently rerouted any process that hadn't loaded `.env` to a stale local
 * database.sqlite. The documented incident: a standalone tsx script reported 121,669
 * screener_appearances rows for Trendlyne with 26 carrying a new column; live Postgres held
 * 435,700 and 0. Nothing errored — it answered, wrongly.
 *
 * These tests fail if an env-selected dialect is reintroduced.
 */
describe('Postgres is the only database', () => {
  const original = process.env.USE_POSTGRES;
  afterEach(() => {
    if (original === undefined) delete process.env.USE_POSTGRES;
    else process.env.USE_POSTGRES = original;
  });

  // NOTE: this file runs UNDER vitest, so process.env.VITEST is set and the fixture branch is
  // what applies by default here. The third test below temporarily unsets VITEST to exercise
  // the real-process branch in-place; the Python suite additionally spawns a genuinely clean
  // interpreter for the same guarantee, which is the stronger check of the two.

  it('inside vitest, SQLite stays the default fixture (safety: tests must not hit prod)', () => {
    delete process.env.USE_POSTGRES;
    expect(process.env.VITEST).toBeTruthy();
    expect(usePostgres()).toBe(false);
  });

  it('inside vitest, a test can still opt INTO Postgres explicitly', () => {
    process.env.USE_POSTGRES = 'true';
    expect(usePostgres()).toBe(true);
  });

  it('the escape hatch is gated on VITEST, which .env cannot supply', () => {
    // Simulate a non-test process: VITEST absent. USE_POSTGRES must then be ignored entirely.
    const vitestFlag = process.env.VITEST;
    delete process.env.VITEST;
    try {
      delete process.env.USE_POSTGRES;
      expect(usePostgres()).toBe(true);      // the incident shape: no .env loaded
      process.env.USE_POSTGRES = 'false';
      expect(usePostgres()).toBe(true);      // .env cannot reroute a real process
      process.env.USE_POSTGRES = '0';
      expect(usePostgres()).toBe(true);      // a typo cannot silently mean SQLite
    } finally {
      if (vitestFlag !== undefined) process.env.VITEST = vitestFlag;
    }
  });

  it('keeps the TS and Python decision points identical', () => {
    // A drift here means the Node server and the ML engines could disagree about which
    // database they are talking to — worse than either default alone.
    const py = readFileSync(new URL('../sql_translate.py', import.meta.url), 'utf8');
    expect(py).toContain('if _in_pytest():');
    expect(py).toContain('return os.environ.get("USE_POSTGRES") == "true"');
    expect(py).toContain('return True');
  });
});
