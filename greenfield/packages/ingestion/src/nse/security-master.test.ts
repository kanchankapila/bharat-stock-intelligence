// Task 2.3 Verify: "a query asserting that at least one symbol has a
// non-NULL listed_to predating the latest session -- if zero, the universe
// is still survivorship-biased and the task has failed."
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool, closeRun, openRun } from '@greenfield/db';
import { deriveSecurityMaster } from './security-master.js';

let pool: pg.Pool;

function metrics(n: number) {
  return { rowsSeen: n, rowsAccepted: n, rowsRejected: 0, rowsWritten: n, symbolsCovered: n, inputWatermark: null, outputWatermark: null };
}

beforeEach(async () => {
  pool = createPool();
  await pool.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ('zzzsm', 'ZZZ Security Master Test', '{}', 'none', 'permitted')`,
  );
  await pool.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ('zzzsm.bars', 'zzzsm', 'ingestion', 'fixture', 'v1')`,
  );
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('zzzsm-job', 'security master test job', 'Asia/Kolkata', 'v1')`,
  );
  await pool.query(
    `INSERT INTO security (symbol, name, exchange, status, listed_from) VALUES
       ('ZZZALIVE', 'ZZZ Alive Co', 'NSE', 'listed', '2026-08-10'),
       ('ZZZDEAD',  'ZZZ Dead Co',  'NSE', 'listed', '2026-08-10')`,
  );

  const client = await pool.connect();
  try {
    // ZZZALIVE: present on every session including the latest (2026-08-12).
    for (const date of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      const runId = await openRun(client, { jobId: 'zzzsm-job', endpointKey: 'zzzsm.bars', codeCommit: 'test' });
      await client.query(
        `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
         VALUES ('ZZZALIVE', $1, '1d', 'nse', 100, now(), $2)`,
        [date, runId],
      );
      await closeRun(client, runId, { status: 'succeeded', metrics: metrics(1) });
    }
    // ZZZDEAD: only present through 2026-08-11 -- delisted before the latest session.
    for (const date of ['2026-08-10', '2026-08-11']) {
      const runId = await openRun(client, { jobId: 'zzzsm-job', endpointKey: 'zzzsm.bars', codeCommit: 'test' });
      await client.query(
        `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
         VALUES ('ZZZDEAD', $1, '1d', 'nse', 50, now(), $2)`,
        [date, runId],
      );
      await closeRun(client, runId, { status: 'succeeded', metrics: metrics(1) });
    }
  } finally {
    client.release();
  }
});

afterEach(async () => {
  await pool.query(`DELETE FROM market_bar WHERE source = 'nse' AND symbol IN ('ZZZALIVE', 'ZZZDEAD')`);
  await pool.query(`DELETE FROM raw_object WHERE endpoint_key = 'zzzsm.bars'`);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = 'zzzsm-job'`);
  await pool.query(`DELETE FROM security WHERE symbol IN ('ZZZALIVE', 'ZZZDEAD')`);
  await pool.query(`DELETE FROM job_definition WHERE job_id = 'zzzsm-job'`);
  await pool.query(`DELETE FROM provider_endpoint WHERE endpoint_key = 'zzzsm.bars'`);
  await pool.query(`DELETE FROM provider WHERE provider = 'zzzsm'`);
  await pool.end();
});

test('a symbol absent from the latest session gets a non-NULL listed_to and status=delisted', async () => {
  const result = await deriveSecurityMaster(pool);
  expect(result.latestSession).toBe('2026-08-12');

  const { rows } = await pool.query(
    `SELECT symbol, status, listed_from::text, listed_to::text FROM security WHERE symbol = 'ZZZDEAD'`,
  );
  expect(rows[0].status).toBe('delisted');
  expect(rows[0].listed_from).toBe('2026-08-10');
  expect(rows[0].listed_to).toBe('2026-08-11');
  // The actual Verify assertion: listed_to is non-NULL and predates the latest session.
  expect(rows[0].listed_to).not.toBeNull();
  expect(rows[0].listed_to < result.latestSession!).toBe(true);
});

test('a symbol present in the latest session stays listed with a NULL listed_to', async () => {
  await deriveSecurityMaster(pool);
  const { rows } = await pool.query(
    `SELECT status, listed_to FROM security WHERE symbol = 'ZZZALIVE'`,
  );
  expect(rows[0].status).toBe('listed');
  expect(rows[0].listed_to).toBeNull();
});
