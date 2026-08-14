// Task 5.2 Verify #2 / Task 5.6 `promotion-not-premature`, negative-controlled
// per this project's standing convention. Scoped fixtures under a distinct
// ranker_version prefix ('zztestdq5%') and job_id, same isolation pattern as
// stage4/dq-checks.test.ts and stage5/run-ranker.test.ts.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { bulkInsertRecommendations, closeRun, createPool, insertAuditMetric, openRun } from '@greenfield/db';
import { checkPromotionNotPremature } from './dq-checks.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_JOB_ID = 'zztest.dq5';
const SYMBOL = 'HDFCBANK';
const RANKER_VERSION = 'zztestdq5-null-v1';

let pool: pg.Pool;
let runId: string;

beforeEach(async () => {
  pool = createPool();
  await pool.query(`INSERT INTO job_definition (job_id, description, timezone, catalog_version) VALUES ($1, 'dq5 test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`, [TEST_JOB_ID]);
  const client = await pool.connect();
  try {
    runId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, runId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  } finally {
    client.release();
  }
}, 30_000);

afterEach(async () => {
  await pool.query(`DELETE FROM recommendation WHERE ranker_version LIKE 'zztestdq5%'`);
  await pool.query(`DELETE FROM audit_metric WHERE metric_name = 'shadow_period_preregistration' AND params_hash = 'zztestdq5'`);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.end();
}, 30_000);

async function insertRecRow(session: string, publishable: boolean) {
  const client = await pool.connect();
  try {
    await bulkInsertRecommendations(client, [{
      symbol: SYMBOL, asOfSession: session, rankerVersion: RANKER_VERSION,
      generatedAt: `${session}T12:00:00Z`, factsCutoff: `${session}T10:00:00Z`,
      score: 0.5, rank: 1, classification: 'rank_middle', conviction: null,
      engineCoverage: 1, breakdown: {}, vetoReasons: [], runId,
    }]);
    if (publishable) {
      await client.query(
        `UPDATE recommendation SET is_publishable = true WHERE symbol = $1 AND ranker_version = $2 AND generated_at = $3`,
        [SYMBOL, RANKER_VERSION, `${session}T12:00:00Z`],
      );
    }
  } finally {
    client.release();
  }
}

test('promotion-not-premature: info when no recommendation rows exist at all', async () => {
  const outcome = await checkPromotionNotPremature(pool);
  expect(outcome.status).toBe('info');
});

test('promotion-not-premature: info when rows exist but none are publishable, regardless of preregistration', async () => {
  await insertRecRow('2021-02-01', false);
  const outcome = await checkPromotionNotPremature(pool);
  expect(outcome.status).toBe('info');
});

test('promotion-not-premature: FAILS when a publishable row exists with NO shadow period ever preregistered', async () => {
  await insertRecRow('2021-02-01', true);
  const outcome = await checkPromotionNotPremature(pool);
  expect(outcome.status).toBe('fail');
  expect(outcome.detail).toMatch(/NO shadow period was ever preregistered/);
});

test('promotion-not-premature: FAILS when publishable exists but fewer than min_dates sessions have accumulated, PASSES once enough have', async () => {
  const client = await pool.connect();
  const preregRunId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
  await closeRun(client, preregRunId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  await insertAuditMetric(client, {
    runId: preregRunId, metricName: 'shadow_period_preregistration', metricVersion: 'v1',
    dimensions: { min_dates: 3, min_calendar_weeks: 1 }, value: null, nObservations: null,
    dataWatermark: '2021-02-01', paramsHash: 'zztestdq5', codeCommit: 'test',
  });
  client.release();

  // Session 1: publishable (simulates a bug bypassing the promotion gate --
  // the writer itself has no path to set this, per Task 5.1.2's own design).
  await insertRecRow('2021-02-01', true);
  const premature = await checkPromotionNotPremature(pool);
  expect(premature.status).toBe('fail');
  expect(premature.detail).toMatch(/min_dates=3/);

  // Sessions 2 and 3: now 3 distinct sessions have accumulated.
  await insertRecRow('2021-02-02', false);
  await insertRecRow('2021-02-03', false);
  const nowFine = await checkPromotionNotPremature(pool);
  expect(nowFine.status).toBe('info');
}, 30_000);
