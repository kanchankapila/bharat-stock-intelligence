// Task 5.4 Verify (extended): promoteLatestSession must not only flip
// recommendation.is_publishable -- it must also flip the model_version
// LEDGER row to 'active' and stamp promoted_at, and retire whichever row of
// the same model was previously active. Before this test existed, nothing in
// the suite exercised that write at all: a promotion could run cleanly and
// the ledger would silently keep reporting 'shadow' forever.
import { afterEach, beforeEach, expect, test } from 'vitest';
import pg from 'pg';
import { closeRun, createPool, openRun, promoteLatestSession, upsertModelVersion } from './index.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const TEST_MODEL = 'zztest-stage5-model';
const TEST_VERSION = 'zztest-v1';
const TEST_JOB_ID = 'zztest.stage5repo';
const REAL_SYMBOL = 'RELIANCE';

let pool: pg.Pool;
let runId: string;

beforeEach(async () => {
  pool = createPool();
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version) VALUES ($1, 'stage5-repo test job', 'Asia/Kolkata', 'v1') ON CONFLICT DO NOTHING`,
    [TEST_JOB_ID],
  );
  const client = await pool.connect();
  try {
    runId = await openRun(client, { jobId: TEST_JOB_ID, codeCommit: 'test' });
    await closeRun(client, runId, { status: 'succeeded', metrics: { rowsSeen: 1, rowsAccepted: 1, rowsRejected: 0, rowsWritten: 1, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } });
  } finally {
    client.release();
  }
}, 30_000);

afterEach(async () => {
  await pool.query(`DELETE FROM recommendation WHERE ranker_version LIKE $1`, [`${TEST_VERSION}%`]);
  await pool.query(`DELETE FROM model_version WHERE model = $1`, [TEST_MODEL]);
  await pool.query(`DELETE FROM ingestion_run WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.query(`DELETE FROM job_definition WHERE job_id = $1`, [TEST_JOB_ID]);
  await pool.end();
}, 30_000);

test('promoteLatestSession flips the model_version ledger row to active and stamps promoted_at, not just recommendation.is_publishable', async () => {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO recommendation (symbol, as_of_session, ranker_version, generated_at, facts_cutoff, classification, engine_coverage, run_id)
       VALUES ($1, '2027-06-01', $2, now(), now(), 'rank_middle', 1, $3)`,
      [REAL_SYMBOL, TEST_VERSION, runId],
    );
    await upsertModelVersion(client, {
      model: TEST_MODEL, version: TEST_VERSION, state: 'shadow',
      artifactUri: 'local://test', artifactHash: 'zzztesthash',
      trainedAt: new Date().toISOString(), trainWindowStart: '2021-01-04', trainWindowEnd: '2027-06-01',
      embargoDays: 0, metrics: {}, codeCommit: 'test',
    });

    const before = await client.query(`SELECT state, promoted_at FROM model_version WHERE model = $1 AND version = $2`, [TEST_MODEL, TEST_VERSION]);
    expect(before.rows[0].state).toBe('shadow');
    expect(before.rows[0].promoted_at).toBeNull();

    const result = await promoteLatestSession(client, TEST_MODEL, TEST_VERSION);
    expect(result.rowsUpdated).toBe(1);
    expect(result.modelPromoted).toBe(true);

    const after = await client.query(`SELECT state, promoted_at FROM model_version WHERE model = $1 AND version = $2`, [TEST_MODEL, TEST_VERSION]);
    expect(after.rows[0].state).toBe('active');
    expect(after.rows[0].promoted_at).not.toBeNull();
  } finally {
    client.release();
  }
}, 30_000);

test('promoteLatestSession retires a previously-active model_version row of the same model when a new version is promoted, never leaving two active at once', async () => {
  const client = await pool.connect();
  try {
    const oldVersion = `${TEST_VERSION}-old`;
    await upsertModelVersion(client, {
      model: TEST_MODEL, version: oldVersion, state: 'active',
      artifactUri: 'local://old', artifactHash: 'zzzoldhash',
      trainedAt: new Date().toISOString(), trainWindowStart: '2021-01-04', trainWindowEnd: '2027-05-01',
      embargoDays: 0, metrics: {}, codeCommit: 'test',
    });
    await upsertModelVersion(client, {
      model: TEST_MODEL, version: TEST_VERSION, state: 'shadow',
      artifactUri: 'local://new', artifactHash: 'zzznewhash',
      trainedAt: new Date().toISOString(), trainWindowStart: '2021-01-04', trainWindowEnd: '2027-06-01',
      embargoDays: 0, metrics: {}, codeCommit: 'test',
    });
    await client.query(
      `INSERT INTO recommendation (symbol, as_of_session, ranker_version, generated_at, facts_cutoff, classification, engine_coverage, run_id)
       VALUES ($1, '2027-06-01', $2, now(), now(), 'rank_middle', 1, $3)`,
      [REAL_SYMBOL, TEST_VERSION, runId],
    );

    await promoteLatestSession(client, TEST_MODEL, TEST_VERSION);

    const rows = await client.query<{ version: string; state: string }>(`SELECT version, state FROM model_version WHERE model = $1 ORDER BY version`, [TEST_MODEL]);
    const byVersion = Object.fromEntries(rows.rows.map((r) => [r.version, r.state]));
    expect(byVersion[oldVersion]).toBe('retired');
    expect(byVersion[TEST_VERSION]).toBe('active');
    expect(rows.rows.filter((r) => r.state === 'active')).toHaveLength(1);
  } finally {
    client.release();
  }
}, 30_000);

test('promoteLatestSession reports modelPromoted=false (never throws) when no matching model_version row exists', async () => {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO recommendation (symbol, as_of_session, ranker_version, generated_at, facts_cutoff, classification, engine_coverage, run_id)
       VALUES ($1, '2027-06-01', $2, now(), now(), 'rank_middle', 1, $3)`,
      [REAL_SYMBOL, TEST_VERSION, runId],
    );
    // Deliberately no upsertModelVersion call -- the ledger row does not exist.
    const result = await promoteLatestSession(client, TEST_MODEL, TEST_VERSION);
    expect(result.rowsUpdated).toBe(1);
    expect(result.modelPromoted).toBe(false);
  } finally {
    client.release();
  }
}, 30_000);
