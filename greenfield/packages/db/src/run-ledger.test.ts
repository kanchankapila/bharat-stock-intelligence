// Task 1.4 Verify: "an integration test asserting that a written market_bar
// row's run_id resolves to a closed ingestion_run with matching
// rows_written." Plus a direct test of the DB's own CHECK constraint
// (status <> 'skipped' OR skip_reason IS NOT NULL) -- Task 1.4 explicitly
// asks for that constraint to be tested, not just assumed from the DDL.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { createPool } from './index.js';
import { closeRun, openRun } from './run-ledger.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

let pool: pg.Pool;
let client: pg.PoolClient;

beforeEach(async () => {
  pool = createPool();
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO provider (provider, display_name, base_hosts, auth_mode, redistribution)
     VALUES ('zzztest', 'ZZZ Test Provider', '{}', 'none', 'permitted')`,
  );
  await client.query(
    `INSERT INTO provider_endpoint (endpoint_key, provider, integration_class, url_template, parser_version)
     VALUES ('zzztest.bars', 'zzztest', 'ingestion', 'http://example.invalid/{symbol}', 'v1')`,
  );
  await client.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('zzztest-job', 'scratch fixture job', 'Asia/Kolkata', 'v1')`,
  );
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status, listed_from)
     VALUES ('ZZZRUNTEST', 'ZZZ Run Test Co', 'NSE', 'listed', '2021-01-04')`,
  );
});

afterEach(async () => {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
});

test('a market_bar row written under a run resolves back to a closed run with matching rows_written', async () => {
  const runId = await openRun(client, { jobId: 'zzztest-job', endpointKey: 'zzztest.bars', codeCommit: 'test-commit' });

  await client.query(
    `INSERT INTO market_bar (symbol, session_date, interval, source, close, available_at, run_id)
     VALUES ('ZZZRUNTEST', '2026-08-13', '1d', 'zzztest', 100.0, now(), $1)`,
    [runId],
  );

  await closeRun(client, runId, {
    status: 'succeeded',
    metrics: {
      rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1,
      symbolsCovered: 1, inputWatermark: null, outputWatermark: '2026-08-13',
    },
  });

  const { rows } = await client.query(
    `SELECT r.status, r.rows_written, r.finished_at
     FROM market_bar b
     JOIN ingestion_run r ON r.run_id = b.run_id
     WHERE b.symbol = 'ZZZRUNTEST'`,
  );

  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('succeeded');
  expect(rows[0].rows_written).toBe(1);
  expect(rows[0].finished_at).not.toBeNull();
});

test('closeRun throws before reaching the DB if status=skipped has no reason', async () => {
  const runId = await openRun(client, { jobId: 'zzztest-job', codeCommit: 'test-commit' });
  await expect(
    // @ts-expect-error -- deliberately constructing an invalid skipped result
    closeRun(client, runId, { status: 'skipped', metrics: emptyMetrics() }),
  ).rejects.toThrow(/requires a reason/);
});

test('the DATABASE ITSELF rejects status=skipped with a NULL skip_reason -- not just the JS wrapper', async () => {
  const runId = await openRun(client, { jobId: 'zzztest-job', codeCommit: 'test-commit' });
  await expect(
    client.query(`UPDATE ingestion_run SET status = 'skipped', skip_reason = NULL WHERE run_id = $1`, [runId]),
  ).rejects.toThrow(/violates check constraint/);
});

function emptyMetrics() {
  return {
    rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0,
    symbolsCovered: 0, inputWatermark: null, outputWatermark: null,
  };
}
