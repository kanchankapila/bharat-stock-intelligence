// Live canary against the REAL NSE archive -- opt-in only
// (RUN_LIVE_DATASOURCE_TESTS=1), never run in CI, same convention this whole
// project already follows (data-sources.md's mandate: every fetcher needs
// one test that hits the real endpoint using the fetcher's OWN resolution/
// parsing/writing, not a hand-rolled reimplementation). A saved-fixture
// contract test proves the parser is correct against a known shape; this
// proves the adapter is STILL correct against what the live archive actually
// returns today.
import { describe, expect, test } from 'vitest';
import pg from 'pg';
import { createPool } from '@greenfield/db';
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
    try {
      await pool.query(
        `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
         VALUES ('nse', 'NSE Archives', '{archives.nseindia.com}', 'none', 'permitted')
         ON CONFLICT (provider) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
         VALUES ('nse.bhavcopy', 'nse', 'ingestion',
                 'https://archives.nseindia.com/products/content/sec_bhavdata_full_{DDMMYYYY}.csv', 'v1')
         ON CONFLICT (endpoint_key) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
         VALUES ('nse.bhavcopy', 'NSE full bhavcopy backfill', 'Asia/Kolkata', 'v1')
         ON CONFLICT (job_id) DO NOTHING`,
      );

      const result = await runBackfillForDate(pool, date, { codeCommit: 'live-canary' });

      expect(result.status).toBe('succeeded');
      expect(result.rowsAccepted).toBeGreaterThan(1000); // real NSE days run ~1800-2200 equity rows

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
      await pool.query(`DELETE FROM market_bar WHERE source = 'nse' AND session_date = $1`, [date]);
      await pool.query(`DELETE FROM delivery_stat WHERE source = 'nse' AND session_date = $1`, [date]);
      await pool.query(`DELETE FROM trading_session WHERE exchange = 'NSE' AND session_date = $1`, [date]);
      await pool.query(`DELETE FROM raw_object WHERE endpoint_key = 'nse.bhavcopy'`);
      await pool.query(`DELETE FROM ingestion_run WHERE job_id = 'nse.bhavcopy'`);
      await pool.query(`DELETE FROM security WHERE listed_from = $1`, [date]);
      await pool.query(`DELETE FROM job_definition WHERE job_id = 'nse.bhavcopy'`);
      await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = 'nse.bhavcopy'`);
      await pool.query(`DELETE FROM provider WHERE provider = 'nse'`);
      await pool.end();
    }
  }, 60_000);
});
