// Live canary against the REAL NSE archive -- opt-in only
// (RUN_LIVE_DATASOURCE_TESTS=1), never run in CI, same convention this whole
// project already follows (data-sources.md's mandate: every fetcher needs
// one test that hits the real endpoint using the fetcher's OWN resolution/
// parsing/writing, not a hand-rolled reimplementation). A saved-fixture
// contract test proves the parser is correct against a known shape; this
// proves the adapter is STILL correct against what the live archive actually
// returns today.
//
// This file deliberately uses the REAL 'nse'/'nse.bhavcopy' identifiers --
// that's the whole point of a live canary (data-sources.md: use the
// fetcher's own real resolution, not a fake). That is exactly what made its
// OLD cleanup dangerous: it unconditionally deleted market_bar/delivery_stat/
// trading_session for the tested date, ALL raw_object/ingestion_run rows for
// job_id='nse.bhavcopy' (no date scope at all), and the shared provider/
// provider_endpoint/job_definition registry rows -- on 2026-08-13 this
// combination is what wiped the real 2021-present backfill after the DB
// held both real and test-canary data simultaneously. Fixed: never delete
// the registry (it's a permanent, idempotent seed, same as
// run-full-backfill.ts's own seedNseBhavcopyRegistry); only delete fact rows
// this SPECIFIC invocation actually created (never when the result was an
// idempotent skip, meaning real production data already owned that date).
import { describe, expect, test } from 'vitest';
import pg from 'pg';
import { createPool, seedNseBhavcopyRegistry } from '@greenfield/db';
import { runBackfillForDate } from './backfill.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const RUN_LIVE = process.env.RUN_LIVE_DATASOURCE_TESTS === '1';

describe.runIf(RUN_LIVE)('nse.bhavcopy [live]', () => {
  test('a real recent trading day flows request -> raw_object -> market_bar with sane values', async () => {
    const pool: pg.Pool = createPool();
    // A real, already-confirmed trading day (verified live 2026-08-13).
    const date = '2026-08-12';
    // Permanent, idempotent registry seed -- same helper the real backfill
    // uses. Never deleted below: it's shared production state, not a fixture.
    await seedNseBhavcopyRegistry(pool);

    const result = await runBackfillForDate(pool, date, { codeCommit: 'live-canary' });
    const thisInvocationWroteData = result.status === 'succeeded' && result.reason !== 'already completed (idempotent no-op)';

    try {
      if (result.reason === 'already completed (idempotent no-op)') {
        // Real production data already covers this date -- that's still a
        // valid live-health signal (the real pipeline reached this date),
        // just verify the data exists rather than asserting a fresh write.
        expect(result.status).toBe('skipped');
      } else {
        expect(result.status).toBe('succeeded');
        expect(result.rowsAccepted).toBeGreaterThan(1000); // real NSE days run ~1800-2200 equity rows
      }

      const { rows } = await pool.query(
        `SELECT symbol, close, run_id, available_at, provenance_quality
         FROM market_bar WHERE symbol = 'RELIANCE' AND session_date = $1`,
        [date],
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].close)).toBeGreaterThan(0);
      expect(rows[0].run_id).toBeTruthy();
      expect(rows[0].available_at).not.toBeNull();
      expect(rows[0].provenance_quality).toBe('recorded'); // NOT 'inferred' -- this is a real rebuild, not a copy

      const { rows: sessionRows } = await pool.query(
        `SELECT is_holiday FROM trading_session WHERE exchange = 'NSE' AND session_date = $1`,
        [date],
      );
      expect(sessionRows[0]?.is_holiday).toBe(false);
    } finally {
      // Only clean up what THIS invocation actually created. If the date was
      // already covered by the real backfill, thisInvocationWroteData is
      // false and nothing here runs -- deleting it would delete real data.
      if (thisInvocationWroteData) {
        await pool.query(`DELETE FROM market_bar WHERE source = 'nse' AND session_date = $1`, [date]);
        await pool.query(`DELETE FROM delivery_stat WHERE source = 'nse' AND session_date = $1`, [date]);
        await pool.query(`DELETE FROM trading_session WHERE exchange = 'NSE' AND session_date = $1`, [date]);
        await pool.query(`DELETE FROM security WHERE listed_from = $1`, [date]);
      }
      // raw_object/ingestion_run rows for this run are left in place -- they
      // are audit history (a real fetch really happened), not test fixtures,
      // and deleting them was never actually necessary for isolation.
      await pool.end();
    }
  }, 60_000);
});
