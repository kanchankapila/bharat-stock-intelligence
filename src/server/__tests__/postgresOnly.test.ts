import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { usePostgres, vitestSchema } from '../pgConfig';

/**
 * TypeScript half of the Postgres-only guarantee. Python half:
 * src/server/tests/test_sql_translate.py.
 *
 * `usePostgres()` used to be `process.env.USE_POSTGRES === 'true'` — SQLite by default. That
 * default silently rerouted any process that hadn't loaded `.env` to a stale local
 * database.sqlite. The documented incident: a standalone tsx script reported 121,669
 * screener_appearances rows for Trendlyne with 26 carrying a new column; live Postgres held
 * 435,700 and 0. Nothing errored — it answered, wrongly.
 *
 * 2026-08-15 closed that for real processes but LEFT the env-var rule inside the test runner,
 * on the reasoning that `VITEST` is runner-owned and `.env` cannot forge it. That reasoning was
 * incomplete and it cost real production data: every `*.live.test.ts` calls
 * `await import('dotenv/config')`, `.env` sets `USE_POSTGRES=true`, and `singleFork: true` means
 * one shared `process.env` — so the first live file to load dotenv flipped every test collected
 * after it onto production Postgres. Measured 2026-08-16: 2,148 fabricated Saturday stock_ohlcv
 * bars written to production, and deliveryFetcher.live failing against empty SQLite in one run
 * and passing against production in the next. There is now no env var at all: Postgres always,
 * with the vitest `unit` project isolated inside a throwaway schema.
 *
 * These tests fail if an env-selected dialect is reintroduced in either language.
 */
describe('Postgres is the only database', () => {
  const original = process.env.USE_POSTGRES;
  afterEach(() => {
    if (original === undefined) delete process.env.USE_POSTGRES;
    else process.env.USE_POSTGRES = original;
  });

  it('no value of USE_POSTGRES can select SQLite, inside vitest or out', () => {
    expect(process.env.VITEST).toBeTruthy();
    for (const v of [undefined, 'false', '0', 'true']) {
      if (v === undefined) delete process.env.USE_POSTGRES;
      else process.env.USE_POSTGRES = v;
      expect(usePostgres()).toBe(true);
    }
  });

  it('holds for a non-test process too (VITEST absent)', () => {
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

  // The isolation half of the guarantee. Postgres-always is only safe because the unit project
  // is pinned to a private schema; without this, "Postgres always" would read "production
  // always" and every fixture write in the suite would land in a live table.
  it('the unit project runs inside a throwaway schema, never production', () => {
    const schema = vitestSchema();
    expect(schema, 'VITEST_PG_SCHEMA is unset — vitest.globalSetup.ts did not run').toBeTruthy();
    expect(schema).toMatch(/^vitest_[0-9a-f]{12}$/);
    expect(schema).not.toBe('public');
  });

  // The two languages are DELIBERATELY not identical right now, and this test pins the
  // difference rather than asserting it away. TS is Postgres-only everywhere (above); Python
  // still honours USE_POSTGRES inside pytest, because ~100 pytest files build their own
  // sqlite3 fixtures and flipping them all at once would point the Python suite at live
  // production — the exact failure a 2026-08-15 attempt produced. That conversion is the
  // remaining half of SQLITE_DECOMMISSION_PLAN Phase 2.
  //
  // When it lands, this test FAILS, which is the point: whoever removes the Python branch is
  // forced to come here and re-assert genuine parity instead of leaving a stale claim behind.
  it('pins the one place TS and Python still differ, so it cannot be forgotten', () => {
    const py = readFileSync(new URL('../sql_translate.py', import.meta.url), 'utf8');
    expect(py).toContain('return True');            // real Python processes: Postgres, no env var
    expect(py).toContain('if _in_pytest():');       // remove this and update this test
  });
});
